/** Retain the same key after an uncertain response; a changed intent gets a new key. */
export class RequestIdentity {
  private pending?: { fingerprint: string; id: string };
  key(fingerprint: string) {
    if (this.pending?.fingerprint !== fingerprint) this.pending = { fingerprint, id: crypto.randomUUID() };
    return this.pending.id;
  }
  confirmed() { this.pending = undefined; }
}
