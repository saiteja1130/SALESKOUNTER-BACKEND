/**
 * Lightweight, zero-dependency cookie parser middleware
 */
export function cookieParser(req, res, next) {
  req.cookies = {};
  const header = req.headers.cookie;
  if (!header) return next();

  const pairs = header.split(";");
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      req.cookies[key] = decodeURIComponent(val);
    }
  }
  next();
}
