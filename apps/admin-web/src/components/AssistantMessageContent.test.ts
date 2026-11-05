import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssistantMessageContent } from '@dsh-work/ui-core'

describe('AssistantMessageContent', () => {
  it('renders readable Markdown structure while keeping model output escaped', () => {
    const wrapper = mount(AssistantMessageContent, { props: { text: [
      '已获取安装计划。',
      '',
      '**来源**',
      '- 仓库：https://github.com/example/skills',
      '- 版本：`abc123`',
      '',
      '1. **grill-me**',
      '   - 描述：主 Skill',
      '2. **grilling**',
      '<img src=x onerror=alert(1)>',
      '',
      '| 术语 | 定义 |',
      '|:---|---:|',
      '| 需求日期 | 工单计划开工日 |',
      '| 锁料 | 固定供给分配结果 |',
      '',
      '```text',
      'Error: tool is not authorized',
      '```',
    ].join('\n') } })

    expect(wrapper.findAll('strong').map(item => item.text())).toEqual(['来源', 'grill-me', 'grilling'])
    expect(wrapper.findAll('li')).toHaveLength(5)
    expect(wrapper.get('ol').text()).toContain('grill-me描述：主 Skillgrilling')
    expect(wrapper.get('code').text()).toBe('abc123')
    expect(wrapper.get('a').attributes()).toMatchObject({ href: 'https://github.com/example/skills', target: '_blank', rel: 'noopener noreferrer' })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
    expect(wrapper.findAll('table')).toHaveLength(1)
    expect(wrapper.findAll('th').map(item => item.text())).toEqual(['术语', '定义'])
    expect(wrapper.findAll('tbody tr').map(item => item.text())).toEqual(['需求日期工单计划开工日', '锁料固定供给分配结果'])
    expect(wrapper.findAll('th')[0]!.attributes('style')).toContain('text-align: left')
    expect(wrapper.findAll('th')[1]!.attributes('style')).toContain('text-align: right')
    expect(wrapper.get('.assistant-code-block > span').text()).toBe('text')
    expect(wrapper.get('pre code').text()).toBe('Error: tool is not authorized')
  })

  describe('EX-STYLE-01 表格工具栏', () => {
    const table = ['| 订单 | 说明 |', '|---|---|', '| **SO-1** | 缺料, "急" |', '| `SO-2` | 正常 |'].join('\n')

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    function button(wrapper: ReturnType<typeof mount>, text: string) {
      const found = wrapper.findAll('button').find(item => item.text() === text)
      expect(found, text).toBeTruthy()
      return found!
    }

    it('shows the size and copies the table as tab-separated text without Markdown marks', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
      const wrapper = mount(AssistantMessageContent, { props: { text: table } })
      expect(wrapper.get('.assistant-table-bar').text()).toContain('2 行 · 2 列')
      await button(wrapper, '复制表格').trigger('click')
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('订单\t说明\nSO-1\t缺料, "急"\nSO-2\t正常')
      expect(wrapper.get('.assistant-table-status').text()).toBe('已复制 2 行，可直接粘贴到表格')
    })

    it('says so when the clipboard is unavailable and the selection fallback fails', async () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
      Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn().mockReturnValue(false) })
      const wrapper = mount(AssistantMessageContent, { props: { text: table } })
      await button(wrapper, '复制表格').trigger('click')
      await flushPromises()
      expect(wrapper.get('.assistant-table-status').text()).toBe('复制失败，请手动选中表格复制')
    })

    it('downloads a UTF-8 CSV with a BOM and quoted cells', async () => {
      let blob: Blob | undefined
      vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blob = value as Blob; return 'blob:table' })
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
      const wrapper = mount(AssistantMessageContent, { props: { text: table } })
      await button(wrapper, '下载 CSV').trigger('click')
      expect(click).toHaveBeenCalled()
      const text = await blob!.text()
      expect(text.charCodeAt(0)).toBe(0xfeff)
      expect(text.slice(1)).toBe('订单,说明\r\nSO-1,"缺料, ""急"""\r\nSO-2,正常')
    })
  })
})
