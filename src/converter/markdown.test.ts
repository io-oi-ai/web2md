import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from './markdown'

describe('任务列表 (Task Lists)', () => {
  it('将已勾选的 checkbox 转换为 [x]', () => {
    const html = '<ul><li><input type="checkbox" checked> 完成 UI 设计稿</li></ul>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('- [x] 完成 UI 设计稿')
  })

  it('将未勾选的 checkbox 转换为 [ ]', () => {
    const html = '<ul><li><input type="checkbox"> 编写前端代码</li></ul>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('- [ ] 编写前端代码')
  })

  it('混合勾选状态的任务列表', () => {
    const html = `<ul>
      <li><input type="checkbox" checked> 完成 UI 设计稿</li>
      <li><input type="checkbox"> 编写前端代码</li>
    </ul>`
    const result = htmlToMarkdown(html)
    expect(result).toContain('- [x] 完成 UI 设计稿')
    expect(result).toContain('- [ ] 编写前端代码')
  })
})

describe('数学公式 (LaTeX)', () => {
  it('保留行内 LaTeX 公式', () => {
    const html = '<p>质能方程 <span class="math-inline">E = mc^2</span> 很著名</p>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('$E = mc^2$')
  })

  it('保留块级 LaTeX 公式', () => {
    const html = '<div class="math-display">\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}</div>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('$$')
    expect(result).toContain('\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}')
  })

  it('保留 MathJax script 标签中的公式', () => {
    const html = '<script type="math/tex">E = mc^2</script>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('$E = mc^2$')
  })

  it('保留 MathJax display script 标签中的公式', () => {
    const html = '<script type="math/tex; mode=display">\\frac{1}{2}</script>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('$$')
    expect(result).toContain('\\frac{1}{2}')
  })
})

describe('脚注 (Footnotes)', () => {
  it('将上标链接转换为脚注引用', () => {
    const html = `
      <p>这是专业术语<sup id="fnref:1"><a href="#fn:1">1</a></sup>。</p>
      <div class="footnotes">
        <ol>
          <li id="fn:1">这里是详细解释。</li>
        </ol>
      </div>
    `
    const result = htmlToMarkdown(html)
    expect(result).toContain('[^1]')
    expect(result).toContain('[^1]:')
  })

  it('保留脚注定义文本', () => {
    const html = `
      <p>术语<sup><a href="#fn:1">1</a></sup></p>
      <div class="footnotes">
        <ol>
          <li id="fn:1">脚注内容说明。</li>
        </ol>
      </div>
    `
    const result = htmlToMarkdown(html)
    expect(result).toContain('[^1]: 脚注内容说明。')
  })
})

describe('Mermaid 流程图', () => {
  it('保留 mermaid 代码块', () => {
    const html = `<pre><code class="language-mermaid">graph TD;
    A[开始] --> B{是否通过};
    B -- 是 --> C[发布];</code></pre>`
    const result = htmlToMarkdown(html)
    expect(result).toContain('```mermaid')
    expect(result).toContain('graph TD;')
  })

  it('保留带 mermaid class 的 div', () => {
    const html = `<div class="mermaid">sequenceDiagram
    Alice->>Bob: Hello</div>`
    const result = htmlToMarkdown(html)
    expect(result).toContain('```mermaid')
    expect(result).toContain('sequenceDiagram')
  })
})

describe('假标题规范化 (Fake Headings)', () => {
  it('将 role=heading + aria-level 的 div 转换为对应标题', () => {
    const html = '<div role="heading" aria-level="2">章节标题</div>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('## 章节标题')
  })

  it('将 class="h2" 的 div 转换为 h2', () => {
    const html = '<div class="h2">二级标题</div>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('## 二级标题')
  })

  it('将 class="h1 some-other-class" 的 span 转换为 h1', () => {
    const html = '<span class="h1 hero-text">主标题</span>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('# 主标题')
  })

  it('不影响真实 h2 标签', () => {
    const html = '<h2>真实标题</h2>'
    const result = htmlToMarkdown(html)
    expect(result).toContain('## 真实标题')
  })
})

describe('代码块污染清除 (Code Block Cleanup)', () => {
  it('移除 pre 内的 copy button', () => {
    const html = `<pre><code class="language-js">const x = 1</code><button class="copy-btn">Copy</button></pre>`
    const result = htmlToMarkdown(html)
    expect(result).not.toContain('Copy')
    expect(result).toContain('const x = 1')
  })

  it('移除 pre 内的行号 span', () => {
    const html = `<pre><span class="line-number">1</span><code>console.log('hello')</code></pre>`
    const result = htmlToMarkdown(html)
    expect(result).not.toContain('line-number')
    expect(result).toContain("console.log('hello')")
  })

  it('移除 pre 内的工具栏 div', () => {
    const html = `<pre><div class="toolbar">JS</div><code class="language-js">let a = 1</code></pre>`
    const result = htmlToMarkdown(html)
    expect(result).not.toContain('toolbar')
    expect(result).toContain('let a = 1')
  })

  it('保留 pre > code 的正常内容不受影响', () => {
    const html = `<pre><code class="language-python">def hello():\n    print("hi")</code></pre>`
    const result = htmlToMarkdown(html)
    expect(result).toContain('```python')
    expect(result).toContain('def hello():')
  })
})

describe('Tabbed Code Blocks 展开', () => {
  it('Docusaurus tabs: 将所有 tab panel 内容顺序展开', () => {
    const html = `
      <div class="tabs-container">
        <ul class="tabs">
          <li class="tabs__item tabs__item--active">npm</li>
          <li class="tabs__item">yarn</li>
        </ul>
        <div class="margin-top--md">
          <div role="tabpanel" class="tabs__content">
            <pre><code>npm install web2md</code></pre>
          </div>
          <div role="tabpanel" class="tabs__content" hidden>
            <pre><code>yarn add web2md</code></pre>
          </div>
        </div>
      </div>
    `
    const result = htmlToMarkdown(html)
    expect(result).toContain('npm install web2md')
    expect(result).toContain('yarn add web2md')
  })

  it('通用 role=tabpanel: 展开所有隐藏 panel', () => {
    const html = `
      <div role="tabpanel" id="panel-ts">
        <pre><code class="language-typescript">const x: number = 1</code></pre>
      </div>
      <div role="tabpanel" id="panel-js" hidden>
        <pre><code class="language-javascript">const x = 1</code></pre>
      </div>
    `
    const result = htmlToMarkdown(html)
    expect(result).toContain('const x: number = 1')
    expect(result).toContain('const x = 1')
  })
})
