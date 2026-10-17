import { Badge, Card, Table, createTheme, type MantineColorsTuple } from '@mantine/core'

// Restrained indigo accent over a neutral surface palette. The report is a
// dashboard, so hierarchy comes from size and ink rather than saturation.
const brand: MantineColorsTuple = [
  '#eef2ff',
  '#e0e7ff',
  '#c7d2fe',
  '#a5b4fc',
  '#818cf8',
  '#6366f1',
  '#4f46e5',
  '#4338ca',
  '#3730a3',
  '#312e81',
]

export const theme = createTheme({
  primaryColor: 'brand',
  colors: { brand },
  defaultRadius: 'md',
  fontFamily:
    "'Inter', 'Segoe UI', system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  fontFamilyMonospace: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
  headings: {
    fontWeight: '500',
    sizes: {
      h3: { fontSize: '16px', lineHeight: '1.35' },
      h4: { fontSize: '14px', lineHeight: '1.35' },
    },
  },
  components: {
    Card: Card.extend({
      defaultProps: { withBorder: true, shadow: 'none', radius: 'md', padding: 'lg' },
    }),
    Badge: Badge.extend({ defaultProps: { radius: 'sm', variant: 'light' } }),
    Table: Table.extend({
      defaultProps: { highlightOnHover: true, verticalSpacing: 'xs', horizontalSpacing: 'sm' },
    }),
  },
})
