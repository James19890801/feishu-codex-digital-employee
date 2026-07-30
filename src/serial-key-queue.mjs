export class SerialKeyQueue {
  #queues = new Map();

  get size() {
    return this.#queues.size;
  }

  run(key, task) {
    const prior = this.#queues.get(key) || Promise.resolve();
    const current = prior.catch(() => {}).then(task);
    this.#queues.set(key, current);
    return current.finally(() => {
      if (this.#queues.get(key) === current) this.#queues.delete(key);
    });
  }
}
