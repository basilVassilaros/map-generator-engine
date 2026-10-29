// Background worker: keeps generation off the interface thread.

import { CoreHost } from "./core-host";
import type { ToCore } from "./protocol";

const host = new CoreHost();
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ToCore>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let queue = Promise.resolve();
scope.onmessage = (e) => {
  queue = queue.then(async () => {
    const out = await host.handle(e.data);
    if (out.type === "frame") scope.postMessage(out, [out.pixels]);
    else scope.postMessage(out);
  });
};
