import { warn } from "../logger.mjs";
import { createRedrawScheduler } from "./overlay-scheduler.mjs";

function pixi() {
  return globalThis.PIXI ?? null;
}

function canvasLayer(layer) {
  const selected = String(layer ?? "tokens");
  return globalThis.canvas?.[selected] ?? null;
}

function isCanvasReady(layer) {
  const target = canvasLayer(layer);
  return Boolean(
    globalThis.canvas?.ready !== false
    && globalThis.canvas?.scene
    && target
    && typeof target.addChild === "function"
  );
}

function destroyDisplayObject(displayObject) {
  try {
    displayObject?.destroy?.({ children: true });
  } catch (_exception) {
    displayObject?.destroy?.();
  }
}

export class CanvasOverlayManager {
  #container = null;
  #draw;
  #hooksRegistered = false;
  #id;
  #insert;
  #layer;
  #scheduler;
  #zIndex;

  constructor({ id, layer = "tokens", zIndex = 0, insert = "below", draw }) {
    this.#id = String(id ?? "aov-skjaldborg-overlay");
    this.#insert = insert === "above" ? "above" : "below";
    this.#layer = layer;
    this.#zIndex = Number(zIndex) || 0;
    this.#draw = typeof draw === "function" ? draw : () => null;
    this.#scheduler = createRedrawScheduler(reason => this.redraw(reason));
  }

  get container() {
    return this.#container && !this.#container.destroyed ? this.#container : null;
  }

  registerHooks(hooks = globalThis.Hooks) {
    if (this.#hooksRegistered || !hooks?.on) return;
    this.#hooksRegistered = true;
    hooks.on("canvasReady", () => this.scheduleRedraw("canvas-ready"));
    hooks.on("canvasTearDown", () => this.destroy());
  }

  destroy() {
    this.#scheduler.cancel();
    if (this.#container && !this.#container.destroyed) {
      try {
        this.#container.parent?.removeChild?.(this.#container);
      } catch (_exception) {
        // Canvas teardown may already have removed the layer.
      }
      destroyDisplayObject(this.#container);
    }
    this.#container = null;
  }

  scheduleRedraw(reason = "unknown") {
    this.#scheduler.schedule(reason);
  }

  redraw(reason = "manual") {
    const container = this.#ensureContainer();
    if (!container) return null;
    try {
      return this.#draw({ container, reason, manager: this });
    } catch (exception) {
      warn(exception);
      return null;
    }
  }

  #ensureContainer() {
    if (!isCanvasReady(this.#layer)) return null;
    if (this.#container && !this.#container.destroyed) return this.#container;
    const PIXI = pixi();
    const layer = canvasLayer(this.#layer);
    if (!PIXI?.Container || !layer) return null;

    const container = new PIXI.Container();
    container.name = this.#id;
    container.sortableChildren = true;
    container.zIndex = this.#zIndex;
    container.interactiveChildren = false;
    try {
      container.eventMode = "none";
    } catch (_exception) {
      // Older PIXI builds ignore eventMode.
    }

    try {
      if (this.#insert === "below" && typeof layer.addChildAt === "function") layer.addChildAt(container, 0);
      else layer.addChild(container);
      this.#container = container;
      return container;
    } catch (exception) {
      destroyDisplayObject(container);
      warn(exception);
      return null;
    }
  }
}
