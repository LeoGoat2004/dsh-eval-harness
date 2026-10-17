import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import App from './App.tsx'
import { theme } from './theme.ts'
import type { DashboardData } from './types.ts'
import './styles.css'

declare global {
  interface Window {
    __DASHBOARD_DATA__?: DashboardData
  }
}

const data = window.__DASHBOARD_DATA__
const root = document.getElementById('root')
if (root === null) throw new Error('dashboard: #root is missing')

if (data === undefined) {
  root.innerHTML =
    '<main class="empty-state"><h1>没有运行数据</h1><p>这个页面需要由 <code>scripts/dashboard.mjs</code> 生成后再打开。</p></main>'
} else {
  createRoot(root).render(
    <StrictMode>
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <App data={data} />
      </MantineProvider>
    </StrictMode>,
  )
}
