/** Последовательная обработка по ключу (пользователю): события одного пользователя не гоняются друг с другом. */
export class KeyedLock {
  private readonly tails = new Map<number, Promise<unknown>>();

  run<T>(key: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
