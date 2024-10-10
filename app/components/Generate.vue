<script lang="ts" setup>
import { fromUint8Array } from 'js-base64'
import { blockToBinary, createEncoder, type EncodedBlock, type LtEncoder } from 'luby-transform'
import { renderSVGDual } from '~/utils/qr'

const props = withDefaults(defineProps<{
  data: Uint8Array
  filename?: string
  contentType?: string
  maxScansPerSecond: number
  sliceSize: number
}>(), {
  maxScansPerSecond: 20,
  sliceSize: 1000,
})

const count = ref(0)
let encoder: LtEncoder
watch(() => [props.data, props.sliceSize], () => {
  encoder = createEncoder(props.data, props.sliceSize)
}, { immediate: true })
const svg = ref<string>()
const blocks = shallowRef<[EncodedBlock, EncodedBlock]>()

const renderTime = ref(0)
const framePerSecond = computed(() => 1000 / renderTime.value)

const formattedIndices = computed(() => {
  const _blocks = blocks.value
  if (!_blocks) {
    return '-, -'
  }
  return `${_blocks[0].indices}, ${_blocks[1].indices}`
})

const formattedK = computed(() => {
  const _blocks = blocks.value
  if (!_blocks) {
    return '-, -'
  }
  return `${_blocks[0].k}, ${_blocks[1].k}`
})

const formattedKBytes = computed(() => {
  const rawKB = useNumberFormat(computed(() => {
    const _blocks = blocks.value
    if (!_blocks) {
      return '0.00'
    }
    return ((_blocks[0].bytes + _blocks[1].bytes) / 1024).toFixed(2)
  }))
  return `${rawKB.value} KB`
})

const formattedKbps = computed(() => {
  const rawKbps = useNumberFormat(computed(() => {
    const _blocks = blocks.value
    if (!_blocks) {
      return '0.00'
    }
    return ((_blocks[0].bytes + _blocks[1].bytes) / 1024 * framePerSecond.value * 8).toFixed(2)
  }))
  return `${rawKbps.value} Kbps`
})

onMounted(() => {
  let frame = performance.now()

  useIntervalFn(() => {
    count.value += 2
    const block1 = encoder.fountain().next().value
    const block2 = encoder.fountain().next().value
    const ch1 = fromUint8Array(blockToBinary(block1))
    const ch2 = fromUint8Array(blockToBinary(block2))
    blocks.value = [block1, block2]
    svg.value = renderSVGDual(ch1, ch2, { border: 5 })
    const now = performance.now()
    renderTime.value = now - frame
    frame = now
  }, () => 1000 / props.maxScansPerSecond)
})
</script>

<template>
  <div w-full flex flex-col items-center gap-4>
    <Collapsable w-full>
      <div grid-cols="[150px_1fr]" font="mono!" grid w-full gap-x-4 gap-y-2 overflow-x-auto whitespace-nowrap p2 text-sm>
        <span text-neutral-500>Indices</span>
        <span text-right md:text-left>{{ formattedIndices }}</span>
        <span text-neutral-500>Total</span>
        <span text-right md:text-left>{{ formattedK }}</span>
        <span text-neutral-500>Bytes</span>
        <span text-right md:text-left>{{ formattedKBytes }}</span>
        <span text-neutral-500>Bitrate</span>
        <span text-right md:text-left>{{ formattedKbps }}</span>
        <span text-neutral-500>Frame Count</span>
        <span text-right md:text-left>{{ count }}</span>
        <span text-neutral-500>FPS</span>
        <span text-right md:text-left>{{ framePerSecond.toFixed(2) }}</span>
      </div>
    </Collapsable>
    <div
      w-full flex flex-col items-center
      max-h="[calc(100vh-250px)]"
      max-w="[calc(100vh-250px)]"
    >
      <div relative w-full>
        <div
          class="aspect-square [&>svg]:h-full [&>svg]:w-full"
          h-full w-full overflow-hidden rounded="~ sm:lg"
          v-html="svg"
        />
      </div>
    </div>
  </div>
</template>

<style>
.arc {
  box-sizing: border-box;
  border-radius: 50%;
  background: #285655;
  mix-blend-mode: lighten;
  mask:
    linear-gradient(#000 0 0) content-box intersect,
    conic-gradient(#000 var(--deg), #0000 0);
}
</style>
