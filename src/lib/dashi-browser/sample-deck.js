export const sampleDeck = {
  schema: 'dashi.browser.deck/v1',
  id: 'browser-demo',
  title: 'Dashi Browser Demo',
  theme: 'theme01',
  slides: [
    {
      id: 'cover',
      label: 'Cover',
      content: {
        presentation: {
          title: 'Browser-first Dashi PPT',
          summary: '原主题视觉 · 浏览器编辑 · 无服务器 Chromium'
        },
        meta: { pageLabel: '01' }
      },
      variants: [
        {
          id: 'v1',
          kind: 'template',
          layout: 'theme01_page001',
          props: {},
          contentMap: {
            titleTop: 'presentation.title',
            lead: 'presentation.summary'
          }
        }
      ]
    },
    {
      id: 'content',
      label: 'Content',
      content: {
        presentation: {
          title: '为什么使用 Browser Harness',
          summary: '运行时只需要浏览器，状态由宿主保存。',
          items: [
            { label: 'Theme Runtime', detail: '直接加载原 Dashi 视觉组件' },
            { label: 'Editable', detail: '文字、媒体和控件状态可回写' },
            { label: 'Export', detail: '浏览器直接生成 PPTX' }
          ]
        }
      },
      variants: [
        {
          id: 'v1',
          kind: 'template',
          layout: 'theme01_page010',
          props: {},
          contentMap: {
            title: 'presentation.title',
            cn: 'presentation.summary'
          }
        }
      ]
    }
  ]
};
