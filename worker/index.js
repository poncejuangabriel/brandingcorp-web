// Fotos que suben los clientes para productos personalizados (placas, etc.)
const FOTO_MAX_BYTES = 15 * 1024 * 1024;
const FOTO_TTL = 180 * 24 * 3600; // se borran solas a los 6 meses
const FOTO_ID = /^[a-f0-9]{32}$/;

// Nombre de los productos personalizados (chanclas, etc.)
const NOMBRE = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,11}$/u;

// ── Vales de premio (tabla "vales" en D1, ver schema.sql) ──────────────────────
// Cada código regala 1 unidad de un producto, una sola vez. El código se reserva al ir a pagar
// y queda usado cuando Stripe confirma el pedido; si el cliente abandona el pago, se libera.
const VALE_MAX_FALLOS = 5;
const VALE_VENTANA_MS = 15 * 60 * 1000;
const normalizarVale = c => (typeof c === 'string' ? c : '').toUpperCase().replace(/[\s-]/g, '');

class ValeError extends Error {
  constructor(message, status = 400, motivo = 'error') { super(message); this.status = status; this.motivo = motivo; }
}

// Límite anti fuerza bruta: solo cuentan los códigos que no existen
async function valeLimite(env, ip) {
  const desde = Date.now() - VALE_VENTANA_MS;
  const { n } = await env.VALES.prepare('SELECT COUNT(*) AS n FROM vale_intentos WHERE ip = ? AND ts > ?').bind(ip, desde).first();
  if (n >= VALE_MAX_FALLOS) {
    throw new ValeError('Demasiados intentos con códigos incorrectos. Espera 15 minutos y vuelve a probar.', 429, 'limite');
  }
}

async function valeFallo(env, ip) {
  await env.VALES.batch([
    env.VALES.prepare('INSERT INTO vale_intentos (ip, ts) VALUES (?, ?)').bind(ip, Date.now()),
    env.VALES.prepare('DELETE FROM vale_intentos WHERE ts < ?').bind(Date.now() - VALE_VENTANA_MS),
  ]);
}

async function stripeApi(env, method, path, body) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { ok: res.ok, data: await res.json() };
}

// Busca el vale y pone al día su estado con Stripe. Con liberar=true (al ir a pagar), una
// reserva con el pago todavía abierto se cancela para que el cliente pueda volver a intentarlo.
async function valeBuscar(env, gymId, codigoCliente, ip, liberar) {
  await valeLimite(env, ip);
  const codigo = normalizarVale(codigoCliente);
  const vale = /^[A-Z0-9]{4,32}$/.test(codigo)
    ? await env.VALES.prepare('SELECT * FROM vales WHERE codigo = ? AND campana = ?').bind(codigo, gymId).first()
    : null;
  if (!vale) {
    await valeFallo(env, ip);
    throw new ValeError('Ese código no existe. Revisa que esté bien escrito.', 404, 'no_existe');
  }

  if (vale.estado === 'reservado') {
    const usado = () => env.VALES.prepare("UPDATE vales SET estado = 'usado', usado_at = ? WHERE codigo = ? AND estado = 'reservado'").bind(Date.now(), codigo).run();
    const soltar = () => env.VALES.prepare("UPDATE vales SET estado = 'libre', session_id = NULL, reservado_at = NULL WHERE codigo = ? AND estado = 'reservado' AND session_id IS ?").bind(codigo, vale.session_id).run();
    if (vale.session_id) {
      const { data: s } = await stripeApi(env, 'GET', 'checkout/sessions/' + vale.session_id);
      if (s.status === 'complete') { await usado(); vale.estado = 'usado'; }
      else if (s.status === 'expired') { await soltar(); vale.estado = 'libre'; }
      else if (s.status === 'open' && liberar) {
        const exp = await stripeApi(env, 'POST', `checkout/sessions/${vale.session_id}/expire`);
        if (exp.ok) { await soltar(); vale.estado = 'libre'; }
        else { // no se pudo cancelar: probablemente se acaba de pagar
          const { data: s2 } = await stripeApi(env, 'GET', 'checkout/sessions/' + vale.session_id);
          if (s2.status === 'complete') { await usado(); vale.estado = 'usado'; }
        }
      }
    } else if (Date.now() - vale.reservado_at > 2 * 60 * 1000) {
      await soltar(); vale.estado = 'libre'; // reserva que se quedó a medias (error al crear el pago)
    }
  }

  if (vale.estado === 'usado') {
    throw new ValeError(`El vale ${vale.visible} ya se ha canjeado.`, 409, 'usado');
  }
  if (vale.estado === 'reservado' && liberar) {
    throw new ValeError(`El vale ${vale.visible} se está usando en otro pedido ahora mismo. Prueba en un par de minutos.`, 409, 'en_uso');
  }
  return vale;
}

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

    const ip = request.headers.get('CF-Connecting-IP') || 'desconocida';

    // Comprobar un vale desde el carrito (no lo reserva ni lo gasta)
    if (pathname === '/vale/comprobar' && request.method === 'POST') {
      try {
        const { gym_id, codigo } = await request.json();
        const vale = await valeBuscar(env, String(gym_id || ''), codigo, ip, false);
        return new Response(JSON.stringify({ ok: true, codigo: vale.visible, producto: vale.producto }), { headers });
      } catch (err) {
        if (err instanceof ValeError) return new Response(JSON.stringify({ error: err.message, motivo: err.motivo }), { status: err.status, headers });
        return new Response(JSON.stringify({ error: 'Error interno: ' + err.message }), { status: 500, headers });
      }
    }

    if (request.method !== 'POST' || pathname !== '/') {
      return new Response(JSON.stringify({ error: 'Método no permitido' }), { status: 405, headers });
    }

    let valeReservado = null; // si falla la creación del pago, se libera
    try {
      const { items, gym_id, success_url, cancel_url, vale: valeCodigo } = await request.json();

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
      const modelos = []; // modelo elegido en productos con varios diseños (calcetines, etc.)
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
        let modelo = '';
        if (product.models) {
          const ids = item.modelo;
          if (!Array.isArray(ids) || ids.length !== (product.model_slots || 1) || !ids.every(id => product.models.some(m => m.id === id))) {
            return new Response(JSON.stringify({ error: `Falta el modelo de «${product.name}». Quítalo del carrito y vuelve a añadirlo eligiendo el modelo.` }), { status: 400, headers });
          }
          const labels = ids.map(id => product.models.find(m => m.id === id).label);
          modelo = (labels.length > 1 ? 'Modelos: ' : 'Modelo: ') + labels.join(' + ');
          modelos.push(`${product.name}, talla ${item.size}, x${qty}: ${labels.join(' + ')}`);
        }
        const desc = [
          modelo,
          product.sizes.length > 1 ? `Talla: ${item.size}` : '',
          product.needs_photo ? 'Con tu foto' : '',
          product.needs_name ? `Nombre: ${item.nombre}` : '',
        ].filter(Boolean).join(' · ');
        line_items.push({
          id: product.id,
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

      // Vale de premio: 1 unidad del producto del vale pasa a 0 €. Se reserva aquí de forma
      // atómica (solo una petición puede pasarlo de "libre" a "reservado").
      let vale = null;
      if (valeCodigo) {
        vale = await valeBuscar(env, gym_id, valeCodigo, ip, true);
        const i = line_items.findIndex(l => l.id === vale.producto);
        if (i < 0) {
          const premio = catalog.find(p => p.id === vale.producto);
          throw new ValeError(`Para usar el vale ${vale.visible} añade al carrito: ${premio ? premio.name : vale.producto}.`, 400, 'falta_producto');
        }
        const l = line_items[i];
        const gratis = {
          ...l,
          quantity: 1,
          price_data: { ...l.price_data, unit_amount: 0, product_data: { ...l.price_data.product_data, name: `${l.price_data.product_data.name} · Vale ${vale.visible}` } },
        };
        if (l.quantity > 1) { l.quantity--; line_items.splice(i + 1, 0, gratis); }
        else line_items[i] = gratis;

        const r = await env.VALES.prepare("UPDATE vales SET estado = 'reservado', session_id = NULL, reservado_at = ? WHERE codigo = ? AND estado = 'libre'")
          .bind(Date.now(), vale.codigo).run();
        if (r.meta.changes !== 1) {
          throw new ValeError(`El vale ${vale.visible} se está usando en otro pedido ahora mismo. Prueba en un par de minutos.`, 409, 'en_uso');
        }
        valeReservado = vale.codigo;
      }
      // Un pedido de 0 € (solo el premio) no tiene pago: Stripe no admite payment_intent_data
      const hayPago = line_items.some(l => l.price_data.unit_amount > 0);

      // Crear sesión de Stripe Checkout
      const body = new URLSearchParams();
      body.append('mode', 'payment');
      body.append('success_url', success_url || 'https://brandingcorp.es/g/' + gym_id + '/?pedido=ok');
      body.append('cancel_url', cancel_url || 'https://brandingcorp.es/g/' + gym_id + '/');
      body.append('locale', 'es');
      // En el pago (Stripe → Pagos → el pedido → Metadatos) aparece el enlace a cada foto, etc.
      const meta = (k, v) => {
        body.append(`metadata[${k}]`, v);
        if (hayPago) body.append(`payment_intent_data[metadata][${k}]`, v);
      };
      meta('gym_id', gym_id || 'desconocido');
      if (vale) meta('vale', `${vale.visible} → ${vale.producto} (gratis)`);
      fotos.forEach((f, i) => meta(`foto_${i + 1}`, f));
      nombres.forEach((n, i) => meta(`nombre_${i + 1}`, n));
      modelos.forEach((m, i) => meta(`modelo_${i + 1}`, m));

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
        throw new Error(session.error?.message || 'Error de Stripe');
      }

      if (valeReservado) {
        await env.VALES.prepare('UPDATE vales SET session_id = ? WHERE codigo = ?').bind(session.id, valeReservado).run();
      }
      return new Response(JSON.stringify({ url: session.url }), { headers });

    } catch (err) {
      if (valeReservado) {
        await env.VALES.prepare("UPDATE vales SET estado = 'libre', reservado_at = NULL WHERE codigo = ? AND estado = 'reservado' AND session_id IS NULL")
          .bind(valeReservado).run().catch(() => {});
      }
      if (err instanceof ValeError) {
        return new Response(JSON.stringify({ error: err.message, motivo: err.motivo }), { status: err.status, headers });
      }
      return new Response(JSON.stringify({ error: 'Error: ' + err.message }), { status: 500, headers });
    }
  }
};
