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

      // Crear líneas de pedido para Stripe
      const line_items = items.map(item => ({
        price_data: {
          currency: 'eur',
          product_data: {
            name: item.name,
            description: item.size && item.size !== 'ÚNICA' && item.size !== 'PACK 3'
              ? `Talla: ${item.size}`
              : undefined,
          },
          unit_amount: Math.round(item.price * 100), // céntimos
        },
        quantity: item.qty,
      }));

      // Crear sesión de Stripe Checkout
      const body = new URLSearchParams();
      body.append('mode', 'payment');
      body.append('success_url', success_url || 'https://brandingcorp.es/g/' + gym_id + '/?pedido=ok');
      body.append('cancel_url', cancel_url || 'https://brandingcorp.es/g/' + gym_id + '/');
      body.append('locale', 'es');

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
