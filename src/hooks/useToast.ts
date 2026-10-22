import { useEffect, useState } from "react";

/** 轻提示：2.2s 后自动消失，新提示会重置计时 */
export function useToast() {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  return { toast, setToast };
}
