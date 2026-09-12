import { DurableObject } from 'cloudflare:workers';
import worker, { RelayCoordinatorCore } from './core.mjs';

export class RelayCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = new RelayCoordinatorCore(ctx, env);
  }

  enqueue(input) { return this.core.enqueue(input); }
  lease(input) { return this.core.lease(input); }
  ack(input) { return this.core.ack(input); }
  status(input) { return this.core.status(input); }
}

export default worker;
