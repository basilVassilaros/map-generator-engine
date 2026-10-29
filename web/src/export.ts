// Saving the generated map as a PNG.
//
// Opened as a file or from any ordinary web host, the browser downloads the
// image directly. Published on claude.ai, pages can't start downloads
// themselves; they ask the viewer through the platform's "downloads"
// capability, which shows a confirmation first.

interface DownloadsCapability {
  save(request: { filename: string; data: Blob }): Promise<{ status: "saved" | "delivered" }>;
}
interface ClaudeRuntime {
  use(name: "downloads"): Promise<DownloadsCapability | null>;
}

/** Export the canvas as a PNG. Returns a short status line for the interface. */
export async function exportPng(canvas: HTMLCanvasElement, filename: string): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return "The image couldn't be created. Try a lower working resolution.";

  const runtime = (window as unknown as { claude?: ClaudeRuntime }).claude;
  if (runtime?.use) {
    const downloads = await runtime.use("downloads");
    if (!downloads) return "Downloads aren't available in this view. Open the page in claude.ai, or run it from the project files.";
    try {
      const result = await downloads.save({ filename, data: blob });
      return result.status === "saved" ? `Saved ${filename}.` : `Sent ${filename}.`;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "declined") return "Export cancelled.";
      if (code === "rate_limited") return "A save is already waiting for confirmation.";
      return "Downloads aren't available in this view.";
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return `Downloaded ${filename}.`;
}
