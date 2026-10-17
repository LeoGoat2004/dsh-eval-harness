import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  AppShell,
  Badge,
  Box,
  Code,
  Divider,
  Group,
  NavLink,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core'
import { IconChartBar, IconCircleCheck, IconFileAnalytics, IconFileText } from '@tabler/icons-react'
import type { DashboardData } from './types.ts'
import { formatDuration } from './format.ts'
import { BenchmarkPanel, MetricsPanel, RunSummaryPanel, TaskDetail } from './panels.tsx'

type View = 'overview' | 'task'

const STATUS_COLOR = { passed: 'teal', failed: 'red', error: 'orange' } as const
const SECTIONS = [
  { id: 'summary', label: '运行摘要', icon: IconFileText },
  { id: 'metrics', label: '运行指标', icon: IconChartBar },
  { id: 'benchmark', label: 'Benchmark 评测', icon: IconCircleCheck },
] as const

/**
 * Dashboard shell: header with run identity, a left rail whose report links
 * scroll to their section (exactly one item is highlighted), and task selection.
 *
 * The highlighted item always equals the section you last navigated to or the
 * section that currently owns the viewport. A short click lock keeps a smooth
 * scroll from briefly highlighting the sections it passes through.
 * @param props - the generated run data.
 */
export default function App({ data }: { readonly data: DashboardData }): JSX.Element {
  const theme = useMantineTheme()
  const [view, setView] = useState<View>('overview')
  const [selectedId, setSelectedId] = useState<string>(data.tasks[0]?.id ?? '')
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id)
  const lockUntil = useRef(0)
  const selected = useMemo(
    () => data.tasks.find((task) => task.id === selectedId) ?? data.tasks[0],
    [data.tasks, selectedId],
  )
  const score = data.totals.tasks === 0 ? 0 : data.totals.passed / data.totals.tasks
  const scoreColor = score === 1 ? 'teal' : score > 0 ? 'orange' : 'red'

  useEffect(() => {
    if (view !== 'overview') return
    const onScroll = (): void => {
      if (Date.now() < lockUntil.current) return
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      let current: string = SECTIONS[0].id
      for (const section of SECTIONS) {
        const element = document.getElementById(section.id)
        if (element !== null && element.getBoundingClientRect().top <= 140) current = section.id
      }
      if (atBottom) current = SECTIONS.at(-1)?.id ?? SECTIONS[0].id
      setActiveSection(current)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [view])

  const openTask = (id: string): void => {
    setSelectedId(id)
    setView('task')
  }
  const scrollToSection = (id: string): void => {
    setView('overview')
    setActiveSection(id)
    // Ignore scroll-spy updates while the smooth scroll animates; the clicked
    // item stays highlighted even when the page cannot scroll far enough.
    lockUntil.current = Date.now() + 900
    window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 20)
  }
  const navStyles = {
    root: { borderRadius: theme.defaultRadius, paddingBlock: 7 },
    label: { fontSize: 13.5 },
  }

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm' }} padding="lg">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Box
              w={28}
              h={28}
              style={{
                borderRadius: theme.defaultRadius,
                background: 'var(--mantine-color-brand-6)',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <IconFileAnalytics size={16} color="white" stroke={1.7} />
            </Box>
            <Stack gap={0}>
              <Title order={5} style={{ letterSpacing: '-0.01em' }}>
                DSH Harness 诊断评测
              </Title>
              <Text size="xs" c="dimmed">
                单次运行报告 · dsh-eval-harness
              </Text>
            </Stack>
          </Group>
          <Group gap={6} wrap="nowrap">
            <Code
              fz={12}
              style={{ color: 'light-dark(var(--mantine-color-gray-9), var(--mantine-color-gray-1))' }}
            >
              {data.manifest.runId}
            </Code>
            <Badge color={scoreColor} size="sm">
              {data.totals.passed}/{data.totals.tasks} 通过
            </Badge>
            <Badge color="gray" variant="light" size="sm">
              dsh {data.manifest.dshVersion}
            </Badge>
            <Badge color="gray" variant="light" size="sm">
              {data.manifest.model.model}
            </Badge>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <Stack gap={2}>
          {SECTIONS.map((section) => (
            <NavLink
              key={section.id}
              label={section.label}
              leftSection={<section.icon size={17} stroke={1.7} />}
              active={view === 'overview' && activeSection === section.id}
              onClick={() => scrollToSection(section.id)}
              styles={navStyles}
            />
          ))}
        </Stack>

        <Divider my="sm" label="任务" labelPosition="left" />
        <Stack gap={2}>
          {data.tasks.map((task) => (
            <NavLink
              key={task.id}
              active={view === 'task' && selected?.id === task.id}
              onClick={() => openTask(task.id)}
              leftSection={
                <Box
                  w={8}
                  h={8}
                  style={{
                    borderRadius: '50%',
                    flex: 'none',
                    background: 'var(--mantine-color-' + STATUS_COLOR[task.status] + '-6)',
                  }}
                />
              }
              label={
                <Text size="sm" ff="monospace" truncate>
                  {task.id}
                </Text>
              }
              rightSection={
                <Text size="xs" c="dimmed">
                  {formatDuration(task.durationMs)}
                </Text>
              }
              styles={navStyles}
            />
          ))}
        </Stack>

        <Divider my="sm" />
        <Text size="xs" c="dimmed" px={8} pb={2}>
          Benchmark
        </Text>
        <Text size="sm" px={8} c="dimmed">
          {data.benchmark.name} · {data.benchmark.language}
        </Text>
        <Text size="xs" px={8} c="dimmed" ff="monospace">
          {data.manifest.benchmarkRevision.slice(0, 10)}
        </Text>
        <Text size="xs" px={8} pt={2} c="dimmed">
          {data.manifest.profile} · {data.manifest.backend}
        </Text>
      </AppShell.Navbar>

      <AppShell.Main>
        {view === 'overview' ? (
          <Stack gap="xl">
            <RunSummaryPanel data={data} />
            <MetricsPanel data={data} onOpenTask={openTask} />
            <BenchmarkPanel data={data} onOpenTask={openTask} />
          </Stack>
        ) : selected === undefined ? (
          <Text c="dimmed">这次运行没有任务。</Text>
        ) : (
          <TaskDetail task={selected} />
        )}
      </AppShell.Main>
    </AppShell>
  )
}
