import type { JSX } from 'react'
import {
  Badge,
  Box,
  Card,
  Code,
  Grid,
  Group,
  Paper,
  Progress,
  RingProgress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core'
import { IconCircleCheck, IconCircleX, IconTool } from '@tabler/icons-react'
import type { DashboardData, EventRow, Finding, TaskData, TraceMetrics } from './types.ts'
import { formatDuration, formatPercent, formatTokens } from './format.ts'

interface PanelProps {
  readonly data: DashboardData
}

interface TaskPanelProps extends PanelProps {
  readonly onOpenTask: (id: string) => void
}

const STATUS_META = {
  passed: { label: '通过', color: 'teal' },
  failed: { label: '失败', color: 'red' },
  error: { label: '错误', color: 'orange' },
} as const

/** Numbered module heading with a one-line purpose. */
function Section(props: {
  readonly id: string
  readonly index: string
  readonly title: string
  readonly description: string
  readonly children: JSX.Element | JSX.Element[]
}): JSX.Element {
  return (
    <Stack gap="md" id={props.id}>
      <Group gap="sm" align="flex-start" wrap="nowrap">
        <Badge variant="light" color="brand" size="lg" radius="sm" ff="monospace">
          {props.index}
        </Badge>
        <Stack gap={1}>
          <Title order={3}>{props.title}</Title>
          <Text size="sm" c="dimmed">
            {props.description}
          </Text>
        </Stack>
      </Group>
      {props.children}
    </Stack>
  )
}

/** Label/value row used inside summary cards. */
function InfoRow(props: { readonly label: string; readonly value: string; readonly mono?: boolean }): JSX.Element {
  return (
    <Group justify="space-between" gap="md" wrap="nowrap" py={3}>
      <Text size="sm" c="dimmed">
        {props.label}
      </Text>
      <Text size="sm" ff={props.mono === true ? 'monospace' : undefined} ta="right" style={{ overflowWrap: 'anywhere' }}>
        {props.value}
      </Text>
    </Group>
  )
}

/** Card title in the dashboard's small-label style. */
function CardLabel({ children }: { readonly children: string }): JSX.Element {
  return (
    <Text size="12px" c="dimmed" fw={500}>
      {children}
    </Text>
  )
}

/** Module 1: benchmark, evaluated DSH configuration, and run manifest. */
export function RunSummaryPanel({ data }: PanelProps): JSX.Element {
  const started = data.manifest.startedAt
  return (
    <Section
      id="summary"
      index="01"
      title="运行摘要"
      description="本次 benchmark、被测 DSH 配置与运行清单——先确认这次跑的到底是什么。"
    >
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        <Card>
          <CardLabel>Benchmark</CardLabel>
          <Stack gap={0} pt={4}>
            <InfoRow label="名称" value={data.benchmark.name} />
            <InfoRow label="语言" value={data.benchmark.language} />
            <InfoRow label="revision" value={data.manifest.benchmarkRevision.slice(0, 12)} mono />
            <InfoRow label="任务" value={String(data.benchmark.tasks.length) + ' 个'} />
          </Stack>
          <Group gap={4} mt="sm">
            {data.benchmark.tasks.map((task) => (
              <Badge key={task} variant="default" size="xs" ff="monospace">
                {task}
              </Badge>
            ))}
          </Group>
        </Card>
        <Card>
          <CardLabel>被测 DSH 配置</CardLabel>
          <Stack gap={0} pt={4}>
            <InfoRow label="DSH 版本" value={data.manifest.dshVersion} mono />
            <InfoRow label="Profile" value={data.manifest.profile} mono />
            <InfoRow label="模型" value={data.manifest.model.provider + ' / ' + data.manifest.model.model} mono />
            <InfoRow label="隔离后端" value={data.manifest.backend} />
          </Stack>
        </Card>
        <Card>
          <CardLabel>运行清单</CardLabel>
          <Stack gap={0} pt={4}>
            <InfoRow label="开始时间" value={started === undefined ? '—' : started.replace('T', ' ').slice(0, 19) + 'Z'} />
            <InfoRow label="总耗时" value={formatDuration(data.totals.durationMs)} />
            <InfoRow label="Token 总量" value={formatTokens(data.totals.totalTokens)} />
            <InfoRow label="工具调用" value={String(data.totals.toolCalls) + ' 次'} />
          </Stack>
        </Card>
        <Card>
          <CardLabel>评测环境</CardLabel>
          {data.environment.recorded ? (
            <Stack gap={0} pt={4}>
              <InfoRow label="后端" value={data.environment.backend} />
              <InfoRow
                label="平台"
                value={
                  (data.environment.platform ?? '—') +
                  ' / ' +
                  (data.environment.arch ?? '—') +
                  ' · node ' +
                  (data.environment.node ?? '—')
                }
              />
              <InfoRow
                label="沙箱 / 审批"
                value={(data.environment.sandbox ?? '—') + ' / ' + (data.environment.approval ?? '—')}
              />
              <InfoRow label="网络" value={data.environment.network?.policy ?? '—'} />
              <InfoRow
                label="模型"
                value={
                  data.environment.model === undefined
                    ? '—'
                    : data.environment.model.provider + ' / ' + data.environment.model.model
                }
              />
              <InfoRow label="模型凭据" value={data.environment.model?.apiKeyEnv ?? '—'} />
              <InfoRow
                label="实际模型"
                value={
                  data.modelVerification?.observed === null || data.modelVerification?.observed === undefined
                    ? '—'
                    : data.modelVerification.observed.provider + ' / ' + data.modelVerification.observed.model
                }
              />
              <InfoRow
                label="用户 home 泄漏"
                value={
                  data.isolation === undefined
                    ? '—'
                    : data.isolation.clean
                      ? '无'
                      : String(data.isolation.homeDirLeaks.length) + ' 条'
                }
              />
              <InfoRow
                label="环境要求"
                value={
                  (data.environment.requirements ?? []).length === 0
                    ? '—'
                    : String((data.environment.requirements ?? []).filter((item) => item.ok).length) +
                      '/' +
                      String((data.environment.requirements ?? []).length) +
                      ' 通过'
                }
              />
              <InfoRow
                label="预检"
                value={data.environment.preflight === undefined ? '—' : data.environment.preflight.ok ? '通过' : '失败'}
              />
              {(data.environment.requirements ?? [])
                .filter((item) => !item.ok)
                .map((item) => (
                  <Text key={item.id} size="xs" c="red" pt={4}>
                    {item.id}: {item.detail}
                  </Text>
                ))}
              {data.modelVerification?.ok === false ? (
                <Text size="xs" c="red" pt={4}>
                  实际模型与声明不一致：声明 {data.modelVerification.declared.provider}/
                  {data.modelVerification.declared.model}，实际 {data.modelVerification.observed?.provider ?? '—'}/
                  {data.modelVerification.observed?.model ?? '—'}
                </Text>
              ) : null}
              {data.isolation !== undefined && !data.isolation.clean ? (
                <Text size="xs" c="red" pt={4}>
                  trace 中出现用户 home 路径：{data.isolation.homeDirLeaks.length} 条（评测环境不纯净）
                </Text>
              ) : null}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed" pt={4}>
              本次运行未记录环境事实（旧格式 run）。
            </Text>
          )}
        </Card>
      </SimpleGrid>
    </Section>
  )
}

/** Module 2: fixed DSH runtime metrics and the anomalies the trace exposed. */
export function MetricsPanel({ data, onOpenTask }: TaskPanelProps): JSX.Element {
  const tokenBuckets = tokenComposition(data.tasks)
  const kpis: { readonly label: string; readonly value: string; readonly tone?: string }[] = [
    { label: 'Turns / Steps', value: turnStepLabel(data) },
    { label: '工具调用', value: String(data.totals.toolCalls) },
    {
      label: '工具失败',
      value: String(data.totals.toolErrors),
      tone: data.totals.toolErrors > 0 ? 'red' : 'teal',
    },
    { label: 'Token 总量', value: formatTokens(data.totals.totalTokens) },
    { label: 'LLM 时间', value: formatDuration(sumMetric(data, 'llmMs')) },
    { label: '工具时间', value: formatDuration(sumMetric(data, 'toolMs')) },
    { label: '重试', value: String(sumMetric(data, 'retries')) },
    { label: '平均延迟', value: formatDuration(averageMetric(data, 'latencyMs')) },
  ]
  return (
    <Section
      id="metrics"
      index="02"
      title="DSH 运行指标"
      description="从完整 trace 抽取的固定指标。分数之外，这里回答「运行得怎么样」。"
    >
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
        {kpis.map((kpi) => (
          <Paper key={kpi.label} withBorder p="md" radius="md">
            <Text size="sm" c="dimmed">
              {kpi.label}
            </Text>
            <Text fz={24} fw={500} lh={1.25} c={kpi.tone}>
              {kpi.value}
            </Text>
          </Paper>
        ))}
      </SimpleGrid>

      <Grid>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card h="100%">
            <CardLabel>Token 构成</CardLabel>
            <Box mt={10} mb={12}>
              <Progress.Root size={10} radius="xl">
                {tokenBuckets.map((bucket) => (
                  <Progress.Section key={bucket.label} value={bucket.ratio * 100} color={bucket.color} />
                ))}
              </Progress.Root>
            </Box>
            <SimpleGrid cols={{ base: 2, sm: 3 }} spacing={6}>
              {tokenBuckets.map((bucket) => (
                <Group key={bucket.label} gap={6} wrap="nowrap">
                  <Box w={8} h={8} bg={bucket.color} style={{ borderRadius: 2, flex: 'none' }} />
                  <Text size="xs" c="dimmed">
                    {bucket.label}
                  </Text>
                  <Text size="xs" ff="monospace" style={{ marginLeft: 'auto' }}>
                    {formatTokens(bucket.value)}
                  </Text>
                </Group>
              ))}
            </SimpleGrid>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card h="100%">
            <CardLabel>运行异常（trace 证据）</CardLabel>
            <Stack gap={8} pt={4}>
              {data.findings.length === 0 ? (
                <Text size="sm" c="dimmed">
                  trace 未发现工具级异常。
                </Text>
              ) : (
                data.findings.map((finding) => <FindingRow finding={finding} key={finding.kind + finding.label} />)
              )}
            </Stack>
          </Card>
        </Grid.Col>
      </Grid>

      <Card padding={0}>
        <Box px="lg" pt="lg" pb="sm">
          <CardLabel>逐任务指标</CardLabel>
        </Box>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>任务</Table.Th>
              <Table.Th>状态</Table.Th>
              <Table.Th>步数</Table.Th>
              <Table.Th>工具调用</Table.Th>
              <Table.Th>工具失败</Table.Th>
              <Table.Th>Token</Table.Th>
              <Table.Th>LLM</Table.Th>
              <Table.Th>工具</Table.Th>
              <Table.Th>耗时</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.tasks.map((task) => (
              <Table.Tr key={task.id} style={{ cursor: 'pointer' }} onClick={() => onOpenTask(task.id)}>
                <Table.Td>
                  <Text size="xs" ff="monospace">
                    {task.id}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" color={STATUS_META[task.status].color}>
                    {STATUS_META[task.status].label}
                  </Badge>
                </Table.Td>
                <Table.Td>{task.metrics?.steps ?? '—'}</Table.Td>
                <Table.Td>{task.metrics?.toolCalls ?? '—'}</Table.Td>
                <Table.Td>
                  <Text
                    size="sm"
                    c={(task.metrics?.toolErrors ?? 0) > 0 ? 'red' : undefined}
                    fw={(task.metrics?.toolErrors ?? 0) > 0 ? 500 : undefined}
                  >
                    {task.metrics?.toolErrors ?? '—'}
                  </Text>
                </Table.Td>
                <Table.Td>{task.metrics === null ? '—' : formatTokens(task.metrics.totalTokens)}</Table.Td>
                <Table.Td>{task.metrics === null ? '—' : formatDuration(task.metrics.llmMs)}</Table.Td>
                <Table.Td>{task.metrics === null ? '—' : formatDuration(task.metrics.toolMs)}</Table.Td>
                <Table.Td>{formatDuration(task.durationMs)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Section>
  )
}

/** Module 3: the benchmark's own verification result. */
export function BenchmarkPanel({ data, onOpenTask }: TaskPanelProps): JSX.Element {
  const checks = data.tasks.reduce(
    (acc, task) => ({
      passed: acc.passed + (task.checks?.passed ?? 0),
      total: acc.total + (task.checks?.total ?? 0),
    }),
    { passed: 0, total: 0 },
  )
  const score = data.totals.tasks === 0 ? 0 : data.totals.passed / data.totals.tasks
  const scoreColor = score === 1 ? 'teal' : score > 0 ? 'orange' : 'red'
  const checkRate = checks.total === 0 ? 0 : checks.passed / checks.total
  return (
    <Section
      id="benchmark"
      index="03"
      title="Benchmark 评测"
      description="判据完全来自 benchmark 自带的验证器（pytest）；这里不做任何再评分。"
    >
      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Card h="100%">
            <Stack align="center" gap="sm" py="sm">
              <RingProgress
                size={150}
                thickness={12}
                roundCaps
                sections={[{ value: score * 100, color: scoreColor }]}
                label={
                  <Stack gap={0} align="center">
                    <Text fz={26} fw={500} lh={1.1}>
                      {formatPercent(score)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {data.totals.passed}/{data.totals.tasks} 任务
                    </Text>
                  </Stack>
                }
              />
              <Text size="sm" c="dimmed">
                check 通过率 {formatPercent(checkRate)}（{checks.passed}/{checks.total}）
              </Text>
            </Stack>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="sm">
            {data.tasks.map((task) => (
              <Paper
                key={task.id}
                withBorder
                p="sm"
                radius="md"
                style={{ cursor: 'pointer' }}
                onClick={() => onOpenTask(task.id)}
              >
                <Group justify="space-between" gap="sm" wrap="nowrap" mb={6}>
                  <Group gap={8} wrap="nowrap">
                    <Badge size="sm" color={STATUS_META[task.status].color}>
                      {STATUS_META[task.status].label}
                    </Badge>
                    <Text size="xs" ff="monospace">
                      {task.id}
                    </Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    {task.checks === null ? '—' : String(task.checks.passed) + '/' + String(task.checks.total) + ' checks'}
                  </Text>
                </Group>
                <Progress
                  value={task.checks === null || task.checks.total === 0 ? 0 : (task.checks.passed / task.checks.total) * 100}
                  color={STATUS_META[task.status].color}
                  size="sm"
                  radius="xl"
                />
                {task.checks?.error === undefined ? null : (
                  <Text size="xs" c="red" pt={6}>
                    验证器失败：{task.checks.error}
                  </Text>
                )}
              </Paper>
            ))}
          </Stack>
        </Grid.Col>
      </Grid>
    </Section>
  )
}

/** Per-task detail view: metrics, execution timeline, checks, and raw events. */
export function TaskDetail({ task }: { readonly task: TaskData }): JSX.Element {
  const markers = timelineMarkers(task.events)
  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Title order={3} ff="monospace">
            {task.id}
          </Title>
          <Text size="sm" c="dimmed">
            exit {task.exitCode ?? '—'} · {formatDuration(task.durationMs)} · {task.timedOut ? '超时终止' : '正常结束'}
          </Text>
          {task.guard === undefined || task.guard === null ? null : (
            <Text size="sm" c="orange">
              熔断：{task.guard.reason}
            </Text>
          )}
        </Stack>
        <Badge color={STATUS_META[task.status].color} size="md">
          {STATUS_META[task.status].label}
        </Badge>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="sm">
        <MiniKpi label="Steps" value={String(task.metrics?.steps ?? '—')} />
        <MiniKpi label="工具调用" value={String(task.metrics?.toolCalls ?? '—')} />
        <MiniKpi label="工具失败" value={String(task.metrics?.toolErrors ?? '—')} bad={(task.metrics?.toolErrors ?? 0) > 0} />
        <MiniKpi label="Token" value={task.metrics === null ? '—' : formatTokens(task.metrics.totalTokens)} />
        <MiniKpi label="checks" value={task.checks === null ? '—' : String(task.checks.passed) + '/' + String(task.checks.total)} />
      </SimpleGrid>

      <Card>
        <CardLabel>执行链</CardLabel>
        <Box className="timeline" mt={10}>
          {markers.map((marker) => (
            <span
              key={marker.key}
              className={'marker marker-' + marker.tone}
              style={{ left: formatPercent(marker.left) }}
              title={marker.type + (marker.summary === undefined ? '' : ' · ' + marker.summary)}
            />
          ))}
        </Box>
        <Group gap="lg" mt={10}>
          <LegendItem color="var(--mantine-color-blue-5)" label="tool call" />
          <LegendItem color="var(--mantine-color-red-6)" label="tool error" round />
          <LegendItem color="var(--mantine-color-gray-5)" label="turn / step" />
        </Group>
      </Card>

      <Grid>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Card h="100%">
            <CardLabel>验证结果</CardLabel>
            <ScrollArea.Autosize mah={260} mt={8} type="auto">
              {task.checks === null ? (
                <Text size="sm" c="dimmed">
                  没有验证结果。
                </Text>
              ) : (
                <Stack gap={2}>
                  {task.checks.items.map((item) => (
                    <Group key={item.id} gap={8} wrap="nowrap">
                      {item.pass ? (
                        <IconCircleCheck size={14} color="var(--mantine-color-teal-6)" style={{ flex: 'none' }} />
                      ) : (
                        <IconCircleX size={14} color="var(--mantine-color-red-6)" style={{ flex: 'none' }} />
                      )}
                      <Text size="xs" ff="monospace" truncate>
                        {item.id}
                      </Text>
                      {item.skipped ? (
                        <Badge size="xs" color="gray">
                          skipped
                        </Badge>
                      ) : null}
                    </Group>
                  ))}
                </Stack>
              )}
            </ScrollArea.Autosize>
          </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card h="100%">
            <CardLabel>事件流</CardLabel>
            <ScrollArea.Autosize mah={260} mt={8} type="auto">
              <Stack gap={0}>
                {task.events
                  .filter(isKeyEvent)
                  .slice(0, 240)
                  .map((event) => (
                    <EventRowView event={event} key={event.seq} />
                  ))}
              </Stack>
            </ScrollArea.Autosize>
          </Card>
        </Grid.Col>
      </Grid>

      <Group gap={6}>
        <IconTool size={13} color="var(--mantine-color-gray-6)" />
        <Text size="sm" c="dimmed">
          原始 trace：<Code>{task.artifacts.trace ?? '（缺失）'}</Code>
        </Text>
      </Group>
    </Stack>
  )
}

function MiniKpi(props: { readonly label: string; readonly value: string; readonly bad?: boolean }): JSX.Element {
  return (
    <Paper withBorder p="sm" radius="md">
      <Text size="sm" c="dimmed">
        {props.label}
      </Text>
      <Text fz={20} fw={500} c={props.bad === true ? 'red' : undefined}>
        {props.value}
      </Text>
    </Paper>
  )
}

function LegendItem(props: { readonly color: string; readonly label: string; readonly round?: boolean }): JSX.Element {
  return (
    <Group gap={6} wrap="nowrap">
      <Box
        w={8}
        h={8}
        style={{ borderRadius: props.round === true ? '50%' : 2, background: props.color, flex: 'none' }}
      />
      <Text size="sm" c="dimmed">
        {props.label}
      </Text>
    </Group>
  )
}

const LAYER_META = {
  model: { label: '模型', color: 'grape', description: '模型侧' },
  harness: { label: '框架', color: 'red', description: 'DSH Harness 侧' },
  environment: { label: '环境', color: 'orange', description: '评测环境侧' },
  benchmark: { label: '基准', color: 'blue', description: 'Benchmark 侧' },
  adapter: { label: '适配器', color: 'gray', description: '适配器侧' },
  unknown: { label: '未定性', color: 'dark', description: '证据不足，不下结论' },
} as const

function FindingRow({ finding }: { readonly finding: Finding }): JSX.Element {
  const layer = LAYER_META[finding.layer]
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" gap="sm" wrap="nowrap">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Badge size="sm" color={layer.color} style={{ flex: 'none' }}>
            {layer.label}
          </Badge>
          <Text size="sm" ff="monospace" style={{ flex: 'none' }}>
            {finding.kind}
          </Text>
          <Text size="sm" c="dimmed" truncate>
            {finding.tasks.join(', ')}
          </Text>
          <Badge size="xs" variant="light" color={finding.confidence === 'confirmed' ? 'red' : 'gray'} style={{ flex: 'none' }}>
            {finding.confidence}
          </Badge>
        </Group>
        <Badge size="sm" color="red" variant="light" style={{ flex: 'none' }}>
          ×{finding.count}
        </Badge>
      </Group>
      <Text size="sm" ff="monospace" lineClamp={2} title={finding.label} mt={6}>
        {finding.label}
      </Text>
      <Text size="xs" c="dimmed" mt={4}>
        {layer.description} · {finding.note}
      </Text>
    </Paper>
  )
}

function EventRowView({ event }: { readonly event: EventRow }): JSX.Element {
  const color = event.error === true ? 'red' : event.type === 'tool/call' ? 'blue' : 'gray'
  return (
    <Group gap={8} wrap="nowrap" py={3} px={6} className={event.error === true ? 'event-row-error' : undefined}>
      <Badge size="xs" color={color} variant="light" style={{ flex: 'none', width: 92 }}>
        {event.type}
      </Badge>
      <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 'none', width: 48 }}>
        T{event.turn}/S{event.step}
      </Text>
      <Text size="sm" ff="monospace" truncate title={event.summary ?? ''} style={{ flex: 1, minWidth: 0 }}>
        {event.summary ?? ''}
      </Text>
    </Group>
  )
}

interface TokenBucket {
  readonly label: string
  readonly value: number
  readonly ratio: number
  readonly color: string
}

/** Token buckets with Mantine palette colors. */
function tokenComposition(tasks: readonly TaskData[]): readonly TokenBucket[] {
  const sum = (pick: (metrics: TraceMetrics) => number): number =>
    tasks.reduce((total, task) => total + (task.metrics === null ? 0 : pick(task.metrics)), 0)
  const buckets = [
    { label: 'input', value: sum((metrics) => metrics.inputTokens), color: 'blue.6' },
    { label: 'cache read', value: sum((metrics) => metrics.cacheReadTokens), color: 'blue.4' },
    { label: 'cache write', value: sum((metrics) => metrics.cacheWriteTokens), color: 'blue.2' },
    { label: 'output', value: sum((metrics) => metrics.outputTokens), color: 'indigo.6' },
    { label: 'reasoning', value: sum((metrics) => metrics.reasoningTokens), color: 'grape.5' },
  ]
  const total = buckets.reduce((acc, bucket) => acc + bucket.value, 0)
  return buckets.map((bucket) => ({ ...bucket, ratio: total === 0 ? 0 : bucket.value / total }))
}

function sumMetric(data: DashboardData, key: 'llmMs' | 'toolMs' | 'retries'): number {
  return data.tasks.reduce((total, task) => total + (task.metrics === null ? 0 : task.metrics[key]), 0)
}

function averageMetric(data: DashboardData, key: 'latencyMs'): number {
  const values = data.tasks.flatMap((task) => (task.metrics === null ? [] : [task.metrics[key]]))
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
}

function turnStepLabel(data: DashboardData): string {
  const turns = data.tasks.reduce((total, task) => total + (task.metrics?.turns ?? 0), 0)
  const steps = data.tasks.reduce((total, task) => total + (task.metrics?.steps ?? 0), 0)
  return String(turns) + ' / ' + String(steps)
}

/** Types shown in the execution-chain event stream. */
function isKeyEvent(event: EventRow): boolean {
  return (
    event.type === 'tool/call' ||
    event.type === 'tool/result' ||
    event.type === 'turn/start' ||
    event.type === 'turn/end' ||
    event.type === 'step/start' ||
    event.type === 'step/end'
  )
}

interface TimelineMarker {
  readonly key: number
  readonly type: string
  readonly summary: string | undefined
  readonly left: number
  readonly tone: 'call' | 'error' | 'turn'
}

/** Project tool events onto a 0..1 timeline. */
function timelineMarkers(events: readonly EventRow[]): readonly TimelineMarker[] {
  const times = events.map((event) => event.time)
  const start = times.length === 0 ? 0 : Math.min(...times)
  const end = times.length === 0 ? 1 : Math.max(...times)
  const span = Math.max(1, end - start)
  const markers: TimelineMarker[] = []
  for (const event of events) {
    if (event.type !== 'tool/call' && event.type !== 'tool/result') continue
    if (event.type === 'tool/result' && event.error !== true) continue
    markers.push({
      key: event.seq,
      type: event.type,
      summary: event.summary,
      left: (event.time - start) / span,
      tone: event.error === true ? 'error' : event.type === 'tool/call' ? 'call' : 'turn',
    })
  }
  return markers
}
