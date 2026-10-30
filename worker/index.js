// Fotos que suben los clientes para productos personalizados (placas, etc.)
const FOTO_MAX_BYTES = 15 * 1024 * 1024;
const FOTO_TTL = 180 * 24 * 3600; // se borran solas a los 6 meses
const FOTO_ID = /^[a-f0-9]{32}$/;

// Nombre de los productos personalizados (chanclas, etc.)
const NOMBRE = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,11}$/u;

// Detecta el formato por los primeros bytes, sin fiarse de lo que diga el navegador
function fotoType(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|mif1|msf1)$/.test(ascii(8, 12))) return 'image/heic';
  return null;
}

export default {
  async fetch(request, env) {
    // CORS para permitir llamadas desde brandingcorp.es
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const { pathname } = new URL(request.url);

    // Subir foto: devuelve un id que la tienda guarda en el carrito
    if (pathname === '/foto' && request.method === 'POST') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > FOTO_MAX_BYTES) {
        return new Response(JSON.stringify({ error: 'La foto pesa demasiado (máximo 15 MB).' }), { status: 413, headers });
      }
      const type = fotoType(bytes);
      if (!type) {
        return new Response(JSON.stringify({ error: 'El archivo no es una foto válida (JPG, PNG, WEBP o HEIC).' }), { status: 400, headers });
      }
      const id = crypto.randomUUID().replace(/-/g, '');
      await env.FOTOS.put('foto:' + id, bytes, { expirationTtl: FOTO_TTL, metadata: { type } });
      await env.FOTOS.put('ok:' + id, '1', { expirationTtl: FOTO_TTL });
      return new Response(JSON.stringify({ id }), { headers });
    }

    // Ver/descargar foto (el enlace llega en el pedido de Stripe)
    const fotoMatch = pathname.match(/^\/foto\/([a-f0-9]{32})$/);
    if (fotoMatch && request.method === 'GET') {
      const { value, metadata } = await env.FOTOS.getWithMetadata('foto:' + fotoMatch[1], { type: 'arrayBuffer' });
      if (!value) return new Response('Foto no encontrada o caducada', { status: 404 });
      return new Response(value, {
        headers: {
          'Content-Type': metadata?.type || 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (request.method !== 'POST' || pathname !== '/') {
      return new Response(JSON.stringify({ error: 'Método no permitido' }), { status: 405, headers });
    }

    try {
      const { items, gym_id, success_url, cancel_url } = await request.json();

      if (!items || items.length === 0) {
        return new Response(JSON.stringify({ error: 'Carrito vacío' }), { status: 400, headers });
      }

      // Los precios se leen del catálogo publicado, nunca del navegador del cliente
      if (!/^[a-z0-9-]+$/.test(gym_id || '')) {
        return new Response(JSON.stringify({ error: 'Tienda no válida' }), { status: 400, headers });
      }
      const configRes = await fetch(`https://brandingcorp.es/g/${gym_id}/config.json?v=${Date.now()}`, { cf: { cacheTtl: 0 } });
      if (!configRes.ok) {
        return new Response(JSON.stringify({ error: 'Tienda no encontrada' }), { status: 400, headers });
      }
      const catalog = (await configRes.json()).products;

      const line_items = [];
      const fotos = []; // enlaces a las fotos de los productos personalizados
      const nombres = []; // nombres que hay que imprimir en los productos personalizados
      const origin = new URL(request.url).origin;
      for (const item of items) {
        const product = catalog.find(p => p.id === item.id);
        const qty = Number(item.qty);
        if (!product || !Number.isInteger(qty) || qty < 1 || qty > 50 || !product.sizes.includes(item.size)) {
          return new Response(JSON.stringify({ error: 'El carrito ha cambiado. Recarga la página e inténtalo de nuevo.' }), { status: 400, headers });
        }
        if (product.needs_photo) {
          if (!FOTO_ID.test(item.photo || '') || !(await env.FOTOS.get('ok:' + item.photo))) {
            return new Response(JSON.stringify({ error: `Falta la foto de «${product.name}». Quítalo del carrito y vuelve a añadirlo subiendo la foto.` }), { status: 400, headers });
          }
          fotos.push(`${product.name} x${qty}: ${origin}/foto/${item.photo}`);
        }
        if (product.needs_name) {
          if (typeof item.nombre !== 'string' || !NOMBRE.test(item.nombre)) {
            return new Response(JSON.stringify({ error: `Falta el nombre de «${product.name}». Quítalo del carrito y vuelve a añadirlo escribiendo el nombre.` }), { status: 400, headers });
          }
          nombres.push(`${product.name}, talla ${item.size}, x${qty}: ${item.nombre}`);
        }
        const desc = [
          product.sizes.length > 1 ? `Talla: ${item.size}` : '',
          product.needs_photo ? 'Con tu foto' : '',
          product.needs_name ? `Nombre: ${item.nombre}` : '',
        ].filter(Boolean).join(' · ');
        line_items.push({
          price_data: {
            currency: 'eur',
            product_data: {
              name: product.name,
              description: desc || undefined,
            },
            unit_amount: Math.round(product.price * 100), // céntimos
          },
          quantity: qty,
        });
      }

      // Crear sesión de Stripe Checkout
      const body = new URLSearchParams();
      body.append('mode', 'payment');
      body.append('success_url', success_url || 'https://brandingcorp.es/g/' + gym_id + '/?pedido=ok');
      body.append('cancel_url', cancel_url || 'https://brandingcorp.es/g/' + gym_id + '/');
      body.append('locale', 'es');
      body.append('metadata[gym_id]', gym_id || 'desconocido');
      // En el pago (Stripe → Pagos → el pedido → Metadatos) aparece el enlace a cada foto
      body.append('payment_intent_data[metadata][gym_id]', gym_id);
      fotos.forEach((f, i) => {
        body.append(`metadata[foto_${i + 1}]`, f);
        body.append(`payment_intent_data[metadata][foto_${i + 1}]`, f);
      });
      nombres.forEach((n, i) => {
        body.append(`metadata[nombre_${i + 1}]`, n);
        body.append(`payment_intent_data[metadata][nombre_${i + 1}]`, n);
      });

      // Datos de facturación: Stripe los pide en la propia página de pago
      body.append('billing_address_collection', 'required');
      body.append('phone_number_collection[enabled]', 'true');
      body.append('tax_id_collection[enabled]', 'true'); // NIF/CIF opcional para empresas

      line_items.forEach((item, i) => {
        body.append(`line_items[${i}][price_data][currency]`, item.price_data.currency);
        body.append(`line_items[${i}][price_data][unit_amount]`, item.price_data.unit_amount);
        body.append(`line_items[${i}][price_data][product_data][name]`, item.price_data.product_data.name);
        if (item.price_data.product_data.description) {
          body.append(`line_items[${i}][price_data][product_data][description]`, item.price_data.product_data.description);
        }
        body.append(`line_items[${i}][quantity]`, item.quantity);
      });

      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const session = await stripeRes.json();

      if (!stripeRes.ok) {
        return new Response(JSON.stringify({ error: session.error?.message || 'Error de Stripe' }), { status: 500, headers });
      }

      return new Response(JSON.stringify({ url: session.url }), { headers });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Error interno: ' + err.message }), { status: 500, headers });
    }
  }
};
