import { useCallback, useEffect, useRef, useState } from "react";

export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
) {
  const actionRef = useRef(action);
  const runningRef = useRef(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  const execute = useCallback(async (...args: TArgs) => {
    if (runningRef.current) {
      return undefined;
    }

    runningRef.current = true;
    setPending(true);
    try {
      return await actionRef.current(...args);
    } finally {
      runningRef.current = false;
      setPending(false);
    }
  }, []);

  return { execute, pending };
}
