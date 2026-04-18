import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { useMotionUpdatePluginLipSync } from './motion-manager'

interface CoreModelStub {
  setParameterValueById: ReturnType<typeof vi.fn>
  getParameterValueById: ReturnType<typeof vi.fn>
}

function createCtx(model: CoreModelStub, handled = false) {
  return {
    model,
    now: 0,
    timeDelta: 16,
    hookedUpdate: undefined,
    internalModel: {} as any,
    motionManager: {} as any,
    modelParameters: ref({}) as any,
    live2dIdleAnimationEnabled: ref(true),
    live2dAutoBlinkEnabled: ref(true),
    live2dForceAutoBlinkEnabled: ref(false),
    isIdleMotion: true,
    handled,
    markHandled: () => {},
  } as any
}

describe('useMotionUpdatePluginLipSync', () => {
  it('writes ParamMouthOpenY when mouthOpenSize is above threshold', () => {
    const mouthOpenSize = ref(0.42)
    const plugin = useMotionUpdatePluginLipSync(mouthOpenSize)

    const setParameterValueById = vi.fn()
    const getParameterValueById = vi.fn()
    const model: CoreModelStub = { setParameterValueById, getParameterValueById }

    plugin(createCtx(model))

    expect(setParameterValueById).toHaveBeenCalledTimes(1)
    expect(setParameterValueById).toHaveBeenCalledWith('ParamMouthOpenY', 0.42)
  })

  it('does not write when mouthOpenSize is zero (silent)', () => {
    const mouthOpenSize = ref(0)
    const plugin = useMotionUpdatePluginLipSync(mouthOpenSize)

    const setParameterValueById = vi.fn()
    const model: CoreModelStub = {
      setParameterValueById,
      getParameterValueById: vi.fn(),
    }

    plugin(createCtx(model))

    expect(setParameterValueById).not.toHaveBeenCalled()
  })

  it('does not write when mouthOpenSize is at or below the configured threshold', () => {
    const mouthOpenSize = ref(0.005)
    const plugin = useMotionUpdatePluginLipSync(mouthOpenSize, { activeThreshold: 0.01 })

    const setParameterValueById = vi.fn()
    const model: CoreModelStub = {
      setParameterValueById,
      getParameterValueById: vi.fn(),
    }

    plugin(createCtx(model))

    expect(setParameterValueById).not.toHaveBeenCalled()

    mouthOpenSize.value = 0.5
    plugin(createCtx(model))
    expect(setParameterValueById).toHaveBeenCalledWith('ParamMouthOpenY', 0.5)
  })

  it('still overrides when ctx.handled is true (final-stage semantics)', () => {
    const mouthOpenSize = ref(0.8)
    const plugin = useMotionUpdatePluginLipSync(mouthOpenSize)

    const setParameterValueById = vi.fn()
    const model: CoreModelStub = {
      setParameterValueById,
      getParameterValueById: vi.fn(),
    }

    plugin(createCtx(model, true))

    expect(setParameterValueById).toHaveBeenCalledWith('ParamMouthOpenY', 0.8)
  })

  it('applies the normalize option when provided', () => {
    const mouthOpenSize = ref(60)
    const plugin = useMotionUpdatePluginLipSync(mouthOpenSize, {
      normalize: raw => raw / 100,
    })

    const setParameterValueById = vi.fn()
    const model: CoreModelStub = {
      setParameterValueById,
      getParameterValueById: vi.fn(),
    }

    plugin(createCtx(model))

    expect(setParameterValueById).toHaveBeenCalledWith('ParamMouthOpenY', 0.6)
  })

  it('ignores non-finite mouthOpenSize values', () => {
    const mouthOpenSize = ref(Number.NaN)
    const plugin = useMotionUpdatePluginLipSync(mouthOpenSize)

    const setParameterValueById = vi.fn()
    const model: CoreModelStub = {
      setParameterValueById,
      getParameterValueById: vi.fn(),
    }

    plugin(createCtx(model))

    expect(setParameterValueById).not.toHaveBeenCalled()
  })
})
