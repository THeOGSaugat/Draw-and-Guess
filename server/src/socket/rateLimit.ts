/** Simple sliding-window limiter: at most `limit` calls per `windowMs`. */
export function createRateLimiter(limit: number, windowMs: number): () => boolean {
  const hits: number[] = [];
  return () => {
    const now = Date.now();
    while (hits.length > 0 && now - hits[0]! >= windowMs) hits.shift();
    if (hits.length >= limit) return false;
    hits.push(now);
    return true;
  };
}
