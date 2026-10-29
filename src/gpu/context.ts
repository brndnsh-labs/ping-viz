export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  colorSpace: PredefinedColorSpace;
}

export class GpuUnavailableError extends Error {}

/** Errors WebGPU reports asynchronously; the smoke test reads them from `window.__ping`. */
export const gpuErrors: string[] = [];

/**
 * @param capture also allow reading finished frames back (COPY_SRC on the canvas texture), for
 *   screenshots in headless Chrome where the WebGPU canvas isn't composited. Off for visitors.
 */
export async function initGpu(
  canvas: HTMLCanvasElement,
  onLost: (reason: string) => void,
  capture = false,
): Promise<Gpu> {
  const usage = capture
    ? GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    : GPUTextureUsage.RENDER_ATTACHMENT;
  if (!("gpu" in navigator) || !navigator.gpu) {
    throw new GpuUnavailableError(window.isSecureContext ? "no-webgpu" : "insecure-context");
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new GpuUnavailableError("no-adapter");
  const device = await adapter.requestDevice({ label: "ping-viz" });
  device.lost.then((info) => {
    if (info.reason !== "destroyed") onLost(info.message || "device lost");
  });
  device.addEventListener("uncapturederror", (e) => {
    const msg = (e as GPUUncapturedErrorEvent).error.message;
    if (gpuErrors.length < 50) gpuErrors.push(msg);
    console.error("WebGPU:", msg);
  });

  const context = canvas.getContext("webgpu");
  if (!context) throw new GpuUnavailableError("no-context");
  const format = navigator.gpu.getPreferredCanvasFormat();
  // Apple displays (and most recent phones) are wide gamut: present in Display P3 when we can.
  let colorSpace: PredefinedColorSpace = "srgb";
  const wantP3 = window.matchMedia?.("(color-gamut: p3)").matches ?? false;
  if (wantP3) {
    try {
      context.configure({ device, format, alphaMode: "opaque", colorSpace: "display-p3", usage });
      const got = context.getConfiguration?.()?.colorSpace;
      colorSpace = got === undefined || got === "display-p3" ? "display-p3" : "srgb";
    } catch {
      colorSpace = "srgb";
    }
  }
  if (colorSpace === "srgb") context.configure({ device, format, alphaMode: "opaque", colorSpace, usage });
  return { adapter, device, canvas, context, format, colorSpace };
}
