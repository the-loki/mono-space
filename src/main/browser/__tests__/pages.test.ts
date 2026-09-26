import { describe, expect, it } from 'vitest'
import {
  parseExtraHttpHeaders,
  parseGeolocation,
  parseNetworkConditions,
  parseViewport,
} from '../pages'

describe('parseViewport：`<w>x<h>x<dpr>[,mobile][,touch][,landscape]`', () => {
  it('解析宽高与 dpr', () => {
    expect(parseViewport('390x844x3')).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: false,
      hasTouch: false,
      isLandscape: false,
    })
  })

  it('省略 dpr 时 deviceScaleFactor 为 undefined（由调用方补默认 1）', () => {
    const parsed = parseViewport('1024x768')
    expect(parsed.width).toBe(1024)
    expect(parsed.height).toBe(768)
    expect(parsed.deviceScaleFactor).toBeUndefined()
  })

  it('识别 mobile / touch / landscape 标签（顺序无关）', () => {
    const parsed = parseViewport('844x390x2,landscape,touch,mobile')
    expect(parsed.isMobile).toBe(true)
    expect(parsed.hasTouch).toBe(true)
    expect(parsed.isLandscape).toBe(true)
  })

  it('只给部分标签时其余为 false', () => {
    const parsed = parseViewport('390x844x2,mobile')
    expect(parsed.isMobile).toBe(true)
    expect(parsed.hasTouch).toBe(false)
    expect(parsed.isLandscape).toBe(false)
  })

  it('非正宽度抛错', () => {
    expect(() => parseViewport('0x844')).toThrowError(/宽度无效/)
    expect(() => parseViewport('-5x844')).toThrowError(/宽度无效/)
  })

  it('非正高度抛错', () => {
    expect(() => parseViewport('390x0')).toThrowError(/高度无效/)
  })

  it('非正 / 非数字 dpr 抛错', () => {
    expect(() => parseViewport('390x844x0')).toThrowError(/devicePixelRatio 无效/)
    expect(() => parseViewport('390x844xabc')).toThrowError(/devicePixelRatio 无效/)
  })

  it('宽度不是数字时抛错', () => {
    expect(() => parseViewport('abcxdef')).toThrowError(/宽度无效/)
  })
})

describe('parseNetworkConditions：限速预设', () => {
  it('Offline：离线且吞吐为 0', () => {
    expect(parseNetworkConditions('Offline')).toEqual({
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    })
  })

  it('Slow 3G：500Kbps / 400ms RTT 经 DevTools 校准', () => {
    expect(parseNetworkConditions('Slow 3G')).toEqual({
      offline: false,
      latency: 2000,
      downloadThroughput: 50_000,
      uploadThroughput: 50_000,
    })
  })

  it('Slow 4G 与 Fast 3G 数值相同（上游改名后的兼容别名）', () => {
    const slow4g = parseNetworkConditions('Slow 4G')
    const fast3g = parseNetworkConditions('Fast 3G')
    expect(slow4g).toEqual(fast3g)
    expect(slow4g).toEqual({
      offline: false,
      latency: 562.5,
      downloadThroughput: 180_000,
      uploadThroughput: 84_375,
    })
  })

  it('Fast 4G：9Mbps / 60ms RTT 经 DevTools 校准', () => {
    expect(parseNetworkConditions('Fast 4G')).toEqual({
      offline: false,
      latency: 165,
      downloadThroughput: 1_012_500,
      uploadThroughput: 168_750,
    })
  })

  it('返回的是副本，改它不会污染共享预设表', () => {
    const first = parseNetworkConditions('Fast 4G')
    first.latency = -1
    expect(parseNetworkConditions('Fast 4G').latency).toBe(165)
  })

  it('未知名称抛错并列出可选项', () => {
    expect(() => parseNetworkConditions('3G' as never)).toThrowError(/未知的 networkConditions/)
  })
})

describe('parseGeolocation：`lat,long`', () => {
  it('解析合法坐标', () => {
    expect(parseGeolocation('37.7749,-122.4194')).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
    })
  })

  it('空串/空白表示清除（返回 undefined）', () => {
    expect(parseGeolocation('')).toBeUndefined()
    expect(parseGeolocation('   ')).toBeUndefined()
  })

  it('纬度越界或非数字抛错', () => {
    expect(() => parseGeolocation('91,0')).toThrowError(/纬度无效/)
    expect(() => parseGeolocation('-90.1,0')).toThrowError(/纬度无效/)
    expect(() => parseGeolocation('abc,0')).toThrowError(/纬度无效/)
  })

  it('经度越界或非数字抛错', () => {
    expect(() => parseGeolocation('0,181')).toThrowError(/经度无效/)
    expect(() => parseGeolocation('0,-180.1')).toThrowError(/经度无效/)
    expect(() => parseGeolocation('0,abc')).toThrowError(/经度无效/)
  })

  it('边界值被接受', () => {
    expect(parseGeolocation('90,180')).toEqual({ latitude: 90, longitude: 180 })
    expect(parseGeolocation('-90,-180')).toEqual({ latitude: -90, longitude: -180 })
  })
})

describe('parseExtraHttpHeaders：JSON 字符串', () => {
  it('空串表示清除（返回空对象）', () => {
    expect(parseExtraHttpHeaders('')).toEqual({})
    expect(parseExtraHttpHeaders('   ')).toEqual({})
  })

  it('解析键值对', () => {
    expect(parseExtraHttpHeaders('{"X-Custom":"value","Authorization":"Bearer token"}')).toEqual({
      'X-Custom': 'value',
      Authorization: 'Bearer token',
    })
  })

  it('非对象 JSON 抛错', () => {
    expect(() => parseExtraHttpHeaders('[]')).toThrowError(/必须是 JSON 对象/)
    expect(() => parseExtraHttpHeaders('null')).toThrowError(/必须是 JSON 对象/)
    expect(() => parseExtraHttpHeaders('"str"')).toThrowError(/必须是 JSON 对象/)
  })

  it('非法 JSON 抛错', () => {
    expect(() => parseExtraHttpHeaders('{not json}')).toThrowError(/不是合法 JSON/)
  })
})
