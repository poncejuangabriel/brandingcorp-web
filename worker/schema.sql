-- Vales de premio: cada código regala 1 unidad de un producto de la tienda, una sola vez
CREATE TABLE IF NOT EXISTS vales (
  codigo       TEXT PRIMARY KEY,      -- normalizado: mayúsculas, sin guiones ni espacios (XYZAB12)
  visible      TEXT NOT NULL,         -- como va impreso (XYZ-AB12)
  campana      TEXT NOT NULL,         -- id de la tienda (coragem); permite tandas para otras academias
  producto     TEXT NOT NULL,         -- id del producto en g/<campana>/config.json
  estado       TEXT NOT NULL DEFAULT 'libre',  -- libre | reservado (pago en curso) | usado
  session_id   TEXT,                  -- sesión de Stripe que lo tiene reservado o lo usó
  reservado_at INTEGER,
  usado_at     INTEGER,
  creado_at    INTEGER NOT NULL
);

-- Intentos fallidos por IP, para el límite anti fuerza bruta
CREATE TABLE IF NOT EXISTS vale_intentos (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vale_intentos_ip_ts ON vale_intentos (ip, ts);
