# BrandingCorp — Web Project

## Proyecto
Web de posicionamiento B2B para BrandingCorp, plataforma que conecta gimnasios con su comunidad.
URL producción: https://brandingcorp.es
Hosting: GitHub Pages (repo: github.com/poncejuangabriel/brandingcorp-web)
Dominio: IONOS (4x A records @ → 185.199.108-111.153)

## Stack
- HTML/CSS/JS estático — un solo archivo `index.html`
- Sin frameworks, sin build step
- Deploy: `git push origin main` (automático en ~2 min, sin CLI ni ZIP)

## Identidad de marca
- Fuente: Montserrat (Google Fonts, pesos 300–900)
- Rojo corporativo: #C41C1C
- Negro mate: #0A0A0A
- Oscuro: #111111
- Plata: #8A8A8A
- Blanco: #FFFFFF

## Archivos
```
index.html          — web completa (única fuente de verdad)
logo-bc.svg         — logo vectorial (monograma BC + texto "BRANDING CORP")
brandingcorp-web.zip — ZIP para subir a Netlify
```

## Secciones actuales (index.html)
1. Nav fijo con logo y links
2. Hero — "Llevamos tu gimnasio al siguiente nivel"
3. Stats bar — 3 métricas
4. About — quiénes somos
5. Services — 6 tarjetas de servicios
6. Process — 4 pasos
7. Contact — formulario Formspree + email directo
8. Footer

## Formulario de contacto
- Formspree endpoint: https://formspree.io/f/xwvjjvpl
- Campos: nombre, gimnasio, email, teléfono, tamaño gimnasio, mensaje
- Notificaciones van a: contacto@brandingcorp.es

## PENDIENTE — Logo
El logo inline en el HTML no es fiel al original.
El archivo `logo-bc.svg` contiene el diseño de referencia (monograma BC con cuadrado exterior, stroke-width=10).
El logo real tiene B y C claramente separados dentro del cuadrado.
Solución recomendada: pedir al usuario que exporte PNG desde Canva y embeber como base64.

## PENDIENTE — Páginas de gimnasio (Fase 2)
- Páginas privadas por gimnasio: `/gimnasio-[nombre]/index.html`
- Acceso solo mediante QR code — NO enlazadas desde el nav
- Cada página tendrá catálogo de productos y compra
- Generar QR codes apuntando a cada URL

## Deploy en GitHub Pages
```bash
git add .
git commit -m "mensaje del cambio"
git push origin main
# GitHub Pages despliega solo en ~2 minutos
```

## CSS variables
```css
--red: #C41C1C
--red-dark: #9E1515
--black: #0A0A0A
--dark: #111111
--mid: #1A1A1A
--border: #252525
--silver: #8A8A8A
--silver-lt: #B0B0B0
--text: #E0E0E0
--white: #FFFFFF
```
