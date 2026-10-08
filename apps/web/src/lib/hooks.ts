import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useToast } from './toast';

export function useApi<T>(path: string | null, opts: { refetchInterval?: number | false | ((data: T | undefined) => number | false); keepPrevious?: boolean } = {}) {
  return useQuery<T, ApiError>({
    queryKey: [path],
    queryFn: () => api.get<T>(path!),
    enabled: !!path,
    refetchInterval: typeof opts.refetchInterval === 'function' ? (q) => (opts.refetchInterval as (d: T | undefined) => number | false)(q.state.data) : opts.refetchInterval,
    placeholderData: opts.keepPrevious ? (prev) => prev : undefined,
  });
}

/** Mutation helper: shows a toast on success/failure and invalidates queries whose path starts with any prefix. */
export function useAction<V, R = unknown>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); invalidate?: string[]; onSuccess?: (r: R, v: V) => void; silentError?: boolean } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<R, ApiError, V>({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.show(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      for (const prefix of opts.invalidate ?? []) qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith(prefix) });
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      if (!opts.silentError) toast.show(e.message, 'error');
    },
  });
}

export function invalidateKey(qc: ReturnType<typeof useQueryClient>, key: QueryKey) {
  return qc.invalidateQueries({ queryKey: key });
}
