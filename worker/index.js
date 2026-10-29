export default {
  async fetch(request, env) {
    // CORS para permitir llamadas desde brandingcorp.es
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (request.method !== 'POST') {
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
      for (const item of items) {
        const product = catalog.find(p => p.id === item.id);
        const qty = Number(item.qty);
        if (!product || !Number.isInteger(qty) || qty < 1 || qty > 50 || !product.sizes.includes(item.size)) {
          return new Response(JSON.stringify({ error: 'El carrito ha cambiado. Recarga la página e inténtalo de nuevo.' }), { status: 400, headers });
        }
        line_items.push({
          price_data: {
            currency: 'eur',
            product_data: {
              name: product.name,
              description: product.sizes.length > 1 ? `Talla: ${item.size}` : undefined,
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
