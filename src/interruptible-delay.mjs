export class InterruptibleDelay {
  #pending = new Set();
  stopped = false;

  wait(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        this.#pending.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      this.#pending.add(finish);
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const finish of [...this.#pending]) finish();
  }
}
