import { useEffect, useState } from 'react';

/** True once we've been offline for `afterMs` straight (e.g. a sleeping free-tier server is waking up). */
export function useSlowConnect(online: boolean, afterMs = 6000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (online) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(id);
  }, [online, afterMs]);
  return slow;
}
