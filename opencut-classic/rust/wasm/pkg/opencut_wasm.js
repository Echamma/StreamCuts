/* @ts-self-types="./opencut_wasm.d.ts" */

import * as wasm from "./opencut_wasm_bg.wasm";
import { __wbg_set_wasm } from "./opencut_wasm_bg.js";
__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    PreparedColorLut, PreparedHslCurves, PreparedRgbParade, PreparedToneCurves, PreparedVectorscope, SaliencyAnalyzer, TICKS_PER_SECOND, applyEffectPasses, applyMaskFeather, computeRgbParade, computeVectorscope, floorToFrame, formatTimecode, getCompositorCanvas, getLastFrameProfile, guessTimecodeFormat, initCompositor, initializeGpu, isFrameAligned, lastFrameTime, mediaTimeAdd, mediaTimeClamp, mediaTimeFromFrame, mediaTimeFromSeconds, mediaTimeMax, mediaTimeMin, mediaTimeSub, mediaTimeToFrame, mediaTimeToSeconds, parseTimecode, prepareCubeLut, prepareHslCurves, prepareToneCurves, prepareToneCurvesExact, releaseTexture, renderFrame, resizeCompositor, roundToFrame, sampleHslCurve, sampleToneCurve, snappedSeekTime, uploadTexture
} from "./opencut_wasm_bg.js";
