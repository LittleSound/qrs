<script lang="ts" setup>
import { toUint8Array } from 'js-base64'
import { binaryToBlock, readFileHeaderMetaFromBuffer } from 'luby-transform'
import QrScanner from 'qr-scanner'

import { createDecodeWorker } from '~/composables/decode-worker'
import { useKiloBytesNumberFormat } from '~/composables/intlNumberFormat'
import { useBytesRate } from '~/composables/timeseries'
import { CameraSignalStatus } from '~/types'

const props = withDefaults(defineProps<{
  maxScansPerSecond?: number
}>(), {
  maxScansPerSecond: 30,
})

const bytesReceived = ref(0)
const totalValidBytesReceived = ref(0)
const shutterCount = ref(0)

const { formatted: currentValidBytesSpeedFormatted } = useBytesRate(totalValidBytesReceived, {
  interval: 250,
  timeWindow: 1000,
  type: 'counter',
  sampleRate: 50,
  maxDataPoints: 100,
})

const { formatted: currentBytesFormatted } = useBytesRate(bytesReceived, {
  interval: 250,
  timeWindow: 1000,
  type: 'counter',
  sampleRate: 50,
  maxDataPoints: 100,
})

const { bytesRate: fps } = useBytesRate(shutterCount, {
  interval: 250,
  timeWindow: 1000,
  type: 'counter',
  sampleRate: 50,
  maxDataPoints: 100,
})

const { devices } = useDevicesList({
  requestPermissions: true,
  constraints: {
    audio: false,
    video: true,
  },
})

const cameraSignalStatus = ref(CameraSignalStatus.Waiting)
const cameras = computed(() => devices.value.filter(i => i.kind === 'videoinput'))
const selectedCamera = useLocalStorage('qrs-selected-camera', cameras.value[0]?.deviceId)

watchEffect(() => {
  if (!selectedCamera.value)
    selectedCamera.value = cameras.value[0]?.deviceId
})

watch(cameras, () => {
  if (selectedCamera.value && cameras.value.filter(i => i.deviceId === selectedCamera.value).length === 0)
    selectedCamera.value = ''
})

// const results = defineModel<Set<string>>('results', { default: new Set() })

let qrScanner: QrScanner | undefined

const error = ref<any>()
const video = shallowRef<HTMLVideoElement>()
const videoWidth = ref(0)
const videoHeight = ref(0)

onMounted(async () => {
  watch([
    () => props.maxScansPerSecond,
    selectedCamera,
  ], async ([maxScansPerSecond]) => {
    if (qrScanner) {
      qrScanner.destroy()
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    qrScanner = new QrScanner(video.value!, async (result) => {
      try {
        await scanFrame(result)
      }
      catch (e) {
        error.value = e
        console.error(e)
      }
    }, {
      maxScansPerSecond,
      highlightCodeOutline: false,
      highlightScanRegion: true,
      calculateScanRegion: ({ videoHeight, videoWidth }) => {
        const size = Math.min(videoWidth, videoHeight)
        return {
          x: size === videoWidth ? 0 : (videoWidth - size) / 2,
          y: size === videoHeight ? 0 : (videoHeight - size) / 2,
          width: size,
          height: size,
        }
      },
      preferredCamera: selectedCamera.value,
      onDecodeError(e) {
        if (e && e.toString && !e.toString().includes('No QR code found')) {
          console.error(e)
          error.value = e
        }
      },
      async decodeMultiplexer(canvasContext, decode) {
        const imageData = canvasContext.getImageData(0, 0, canvasContext.canvas.width, canvasContext.canvas.height)
        const data = imageData.data
        const length = data.length
        const blue: number[] = Array.from({ length: length / 4 })

        // RED-only channel
        for (let i = 0; i < length; i += 4) {
          data[i + 1] = data[i]!
          blue[i / 4] = data[i + 2] ?? 0
          data[i + 2] = data[i]!
        }
        canvasContext.putImageData(imageData, 0, 0)
        await decode()

        // BLUE-only channel
        for (let i = 0; i < length; i += 4) {
          const b = blue[i / 4] ?? 0
          data[i] = b
          data[i + 1] = b
          data[i + 2] = b
        }
        canvasContext.putImageData(imageData, 0, 0)
        await decode()
      },
    })
    selectedCamera.value && qrScanner.setCamera(selectedCamera.value)
    qrScanner.setInversionMode('both')
    qrScanner.start()
    updateCameraStatus()
  }, { immediate: true })
  watch(selectedCamera, () => {
    if (qrScanner && selectedCamera.value) {
      qrScanner.setCamera(selectedCamera.value)
      qrScanner.start()
    }
  })
  useIntervalFn(() => {
    updateCameraStatus()
  }, 250)
})
onUnmounted(() => qrScanner && qrScanner.destroy())

async function updateCameraStatus() {
  try {
    if (!(navigator && 'mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')) {
      cameraSignalStatus.value = CameraSignalStatus.NotSupported
      return
    }

    videoHeight.value = video.value!.videoHeight
    videoWidth.value = video.value!.videoWidth

    if (videoWidth.value === 0 || videoHeight.value === 0) {
      cameraSignalStatus.value = CameraSignalStatus.Waiting
      return
    }

    cameraSignalStatus.value = CameraSignalStatus.Ready
  }
  catch (e) {
    console.error(e)

    if ((e as Error).name === 'NotAllowedError' || (e as Error).name === 'NotFoundError') {
      cameraSignalStatus.value = CameraSignalStatus.NotGranted
      return
    }

    error.value = e
  }
}

const decoderWorker = createDecodeWorker()
onUnmounted(() => decoderWorker.dispose())
const decoderStatus = ref<Awaited<ReturnType<typeof decoderWorker.getStatus>>>({
  encodedBlocks: new Set(),
  decodedData: [],
  encodedCount: 0,
  decodedCount: 0,
  meta: null!,
})

const k = ref(0)
const bytes = ref(0)
const checksum = ref(0)

const cached = new Set<string>()
const startTime = ref(0)
const endTime = ref(0)

const dataUrl = ref<string>()
const dots = useTemplateRef<HTMLDivElement[]>('dots')
const status = ref<number[]>([])
const decodedBlocks = computed(() => status.value.filter(i => i === 1).length)
const receivedBytes = computed(() => decoderStatus.value.encodedCount * (decoderStatus.value.meta?.data.length ?? 0))

const filename = ref<string | undefined>()
const contentType = ref<string | undefined>()
const textContent = ref<string | undefined>()

const bytesFormatted = useKiloBytesNumberFormat(computed(() => (bytes.value / 1024).toFixed(2)))
const receivedBytesFormatted = useKiloBytesNumberFormat(computed(() => (receivedBytes.value / 1024).toFixed(2)))

function getStatus() {
  const array = Array.from({ length: k.value }, () => 0)
  for (let i = 0; i < k.value; i++) {
    if (decoderStatus.value.decodedData[i] != null)
      array[i] = 1
  }
  for (const block of decoderStatus.value.encodedBlocks) {
    for (const i of block.indices) {
      if (array[i] === 0 || array[i]! > block.indices.length) {
        array[i] = block.indices.length
      }
      else {
        console.warn(`Unexpected block #${i} status: ${array[i]}`)
      }
    }
  }
  return array
}

function pluse(index: number) {
  const el = dots.value?.[index]
  if (!el)
    return
  el.style.transition = 'none'
  el.style.transform = 'scale(1.3)'
  el.style.filter = 'hue-rotate(-90deg)'
  // // force reflow
  void el.offsetWidth
  el.style.transition = 'transform 0.3s, filter 0.3s'
  el.style.transform = 'none'
  el.style.filter = 'none'
}

/**
 * Proposed ideal method to convert data to a data URL
 *
 * @param data - The data to convert
 * @param type - The content type of the data
 */
function toDataURL(data: Uint8Array | string | any, type: string): string {
  if (type.startsWith('text/')) {
    return URL.createObjectURL(new Blob([new TextEncoder().encode(data)], { type: 'text/plain' }))
  }
  else if (type === 'application/json') {
    const json = JSON.stringify(data)
    return URL.createObjectURL(new Blob([new TextEncoder().encode(json)], { type: 'application/json' }))
  }
  else {
    return URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
  }
}

let decoderInitPromise: Promise<any> | undefined
async function scanFrame(result: QrScanner.ScanResult) {
  cameraSignalStatus.value = CameraSignalStatus.Ready

  if (!result.data)
    return

  bytesReceived.value += result.data.length
  totalValidBytesReceived.value = decoderStatus.value.encodedCount * (decoderStatus.value.meta?.data.length ?? 0)

  // Do not process the same QR code twice
  if (cached.has(result.data))
    return
  if (cached.size && result.data) {
    shutterCount.value += 1
  }

  error.value = undefined
  const binary = toUint8Array(result.data)
  const data = binaryToBlock(binary)
  // Data set changed, reset decoder
  if (checksum.value !== data.checksum) {
    if (k.value && !dataUrl.value) {
      // eslint-disable-next-line no-alert
      if (!window.confirm('Scanned different files. You have unfinished transmission, are you sure to start a new one?')) {
        return
      }
    }
    decoderInitPromise = decoderWorker.createDecoder()
    checksum.value = data.checksum
    bytes.value = data.bytes
    k.value = data.k
    startTime.value = now()
    endTime.value = 0
    cached.clear()
    filename.value = undefined
    contentType.value = undefined
    textContent.value = undefined
    dataUrl.value = undefined
  }
  // The previous data set is already decoded, skip for any new blocks
  else if (endTime.value) {
    return
  }
  await decoderInitPromise

  cached.add(result.data)
  k.value = data.k

  data.indices.map(i => pluse(i))
  const success = await decoderWorker.addBlock(data)
  decoderStatus.value = await decoderWorker.getStatus()
  status.value = getStatus()
  if (success) {
    endTime.value = now()

    const merged = (await decoderWorker.getDecoded())!
    const [mergedData, meta] = readFileHeaderMetaFromBuffer(merged)
    dataUrl.value = toDataURL(mergedData, meta.contentType)

    filename.value = meta.filename
    contentType.value = meta.contentType

    if (contentType.value.startsWith('text/')) {
      textContent.value = new TextDecoder().decode(mergedData)
    }
  }
  // console.log({ data })
  // if (Array.isArray(data)) {
  //   if (data[0] !== id.value) {
  //     chunks.length = 0
  //     dataUrl.value = undefined
  //   }

  //

  //   chunks[data[2]] = data
  //   pluse(data[2])

  //   if (!length.value)
  //     return
  //   if (picked.value.every(i => !!i)) {
  //     try {
  //       const merged = merge(picked.value as SliceData[])
  //       dataUrl.value = URL.createObjectURL(new Blob([merged], { type: 'application/octet-stream' }))
  //     }
  //     catch (e) {
  //       error.value = e
  //     }
  //   }
  // }
}

useUnsavedChange(() => {
  if (k.value && !dataUrl.value) {
    return 'You have unfinished transmission, are you sure to leave?'
  }
})

function now() {
  return performance.now()
}
</script>

<template>
  <div items-left flex flex-col gap-4>
    <pre v-if="error" overflow-x-auto text-red v-text="error" />

    <div w-full flex flex-wrap gap-2>
      <button
        v-for="item of cameras" :key="item.deviceId" :class="{
          'text-blue': selectedCamera === item.deviceId,
        }"
        px2 py1 text-sm shadow-sm
        border="~ gray/25 rounded-lg"
        @click="selectedCamera = item.deviceId"
      >
        {{ item.label }}
      </button>
    </div>

    <Collapsable>
      <div grid-cols="[150px_1fr]" font="mono!" :class="endTime ? 'text-green-500' : ''" grid gap-x-4 gap-y-2 overflow-x-auto whitespace-nowrap p2 text-sm>
        <span text-neutral-500>Filename</span>
        <span text-right md:text-left>{{ filename || '<unknown>' }}</span>
        <span text-neutral-500>Content-Type</span>
        <span text-right md:text-left>{{ contentType || '<unknown>' }}</span>
        <span text-neutral-500>Checksum</span>
        <span text-right md:text-left>{{ checksum }}</span>
        <span text-neutral-500>Indices</span>
        <span text-right md:text-left>{{ k }}</span>
        <span text-neutral-500>Decoded</span>
        <span text-right md:text-left>{{ decodedBlocks }}</span>
        <span text-neutral-500>Received blocks</span>
        <span text-right md:text-left>{{ decoderStatus.encodedCount }}</span>
        <span text-neutral-500>Expected bytes</span>
        <span text-right md:text-left>{{ bytesFormatted }}</span>
        <span text-neutral-500>Received bytes</span>
        <span text-right md:text-left>{{ receivedBytesFormatted }} ({{ bytes === 0 ? 0 : (receivedBytes / bytes * 100).toFixed(2) }}%)</span>
        <span text-neutral-500>Time elapsed</span>
        <span text-right md:text-left>{{ k === 0 ? 0 : (((endTime || now()) - startTime) / 1000).toFixed(2) }} s</span>
        <span text-neutral-500>Average bitrate</span>
        <span text-right md:text-left>{{ (receivedBytes / 1024 / ((endTime || now()) - startTime) * 1000).toFixed(2) }} Kbps</span>
      </div>
    </Collapsable>

    <Collapsable v-if="k" :default="k < 500">
      <template #label>
        <span>Packets</span>
        <span ml-2 text-neutral-400>({{ k }})</span>
      </template>
      <div flex="~ col gap-2" p2>
        <div flex="~ gap-0.4 wrap">
          <div
            v-for="x, idx of status"
            :key="idx"
            ref="dots"

            flex="~ items-center justify-center"
            h-4 w-4 overflow-hidden text-8px
            border="~ rounded"
            :class="x === 1 ? 'bg-green:100 border-green4!' : x > 1 ? 'bg-amber border-amber4 text-amber-900 dark:text-amber-200' : 'bg-gray:50 border-gray'"
            :style="{ '--un-bg-opacity': Math.max(0.5, (11 - x) / 10) }"
          >
            {{ ([0, 1, 2].includes(x)) ? '' : x }}
          </div>
        </div>
      </div>
    </Collapsable>

    <Collapsable v-if="dataUrl" label="Download" :default="true">
      <div flex="~ col gap-2" p2>
        <img v-if="contentType?.startsWith('image/')" :src="dataUrl">
        <video v-else-if="contentType?.startsWith('video/')" controls autoplay muted>
          <source :src="dataUrl" :type="contentType">
        </video>
        <p v-else-if="contentType?.startsWith('text/')" :src="dataUrl">
          {{ textContent }}
        </p>
        <a
          :href="dataUrl"
          :download="filename"
          class="w-max border border-gray:50 rounded-md px2 py1 text-sm hover:bg-gray:10"
        >
          Download
        </a>
      </div>
    </Collapsable>

    <!-- This is a progress bar that is not accurate but feels comfortable. -->
    <div v-if="k" relative h-4 rounded bg-black:75 text-white font-mono shadow>
      <div
        bg="green-400" border="~ green4 rounded" transition="all ease" absolute inset-y-0 h-full w-full duration-1000
        :style="{ maxWidth: `${decodedBlocks === k ? 100 : (Math.min(1, receivedBytes / bytes * 0.66) * 100).toFixed(2)}%` }"
      />
    </div>

    <Camera
      :k="k"
      :fps="fps"
      :bytes="bytes"
      :received-bytes="receivedBytes"
      :current-bytes="currentBytesFormatted"
      :current-valid-bytes-speed="currentValidBytesSpeedFormatted"
      :camera-signal-status="cameraSignalStatus"
    >
      <video
        ref="video"
        :controls="false"
        autoplay muted playsinline h-full w-full rounded-lg
      />
    </Camera>

    <Collapsable label="Blocks">
      <div flex="~ gap-1 wrap" max-w-150 text-xs>
        <div v-for="i, idx of decoderStatus.encodedBlocks" :key="idx" border="~ gray/10 rounded" p1>
          <template v-for="x, idy of i.indices" :key="x">
            <span v-if="idy !== 0" op25>, </span>
            <span :style="{ color: `hsl(${x * 40}, 40%, 60%)` }">{{ x }}</span>
          </template>
        </div>
      </div>
    </Collapsable>
  </div>
</template>
