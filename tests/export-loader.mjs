export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'date-fns') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,export function format() { return "formatted date"; }',
    };
  }

  // Toasts are UI side effects; the repo root installs no frontend packages.
  if (specifier === 'sonner') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,const noop = () => {}; export const toast = Object.assign(noop, { success: noop, error: noop, loading: noop, dismiss: noop });',
    };
  }

  if (specifier === './quittance-proof' || specifier === './quittance-proof.js') {
    return nextResolve(new URL('../frontend/lib/quittance-proof.ts', import.meta.url).href, context);
  }

  if (specifier === './explorer-tx-link' || specifier === './explorer-tx-link.js') {
    return nextResolve(new URL('../frontend/lib/explorer-tx-link.ts', import.meta.url).href, context);
  }

  return nextResolve(specifier, context);
}
