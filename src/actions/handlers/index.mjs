export * from './approval-gate.mjs';

/**
 * @deprecated Built-in handlers still live in ../handlers.mjs until the
 * taxonomy split moves implementations module by module.
 */
export {
  actionHandlers,
  actionVerifiers,
} from '../handlers.mjs';
