from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
from reportlab.lib.enums import TA_LEFT, TA_CENTER

doc = SimpleDocTemplate(
    "/mnt/user-data/outputs/Decision_Log.pdf",
    pagesize=A4,
    leftMargin=2.2*cm, rightMargin=2.2*cm,
    topMargin=2*cm, bottomMargin=2*cm
)

W, H = A4
styles = getSampleStyleSheet()

# Custom styles
PURPLE = colors.HexColor('#6c63ff')
DARK = colors.HexColor('#1a1a2e')
GRAY = colors.HexColor('#555577')
LIGHT = colors.HexColor('#f5f5ff')

title_style = ParagraphStyle('Title2', parent=styles['Title'],
    fontSize=22, textColor=DARK, spaceAfter=4, leading=28)
sub_style = ParagraphStyle('Sub', parent=styles['Normal'],
    fontSize=11, textColor=GRAY, spaceAfter=16)
h1_style = ParagraphStyle('H1', parent=styles['Heading1'],
    fontSize=13, textColor=PURPLE, spaceBefore=18, spaceAfter=6,
    borderPad=4)
h2_style = ParagraphStyle('H2', parent=styles['Heading2'],
    fontSize=11, textColor=DARK, spaceBefore=10, spaceAfter=4, fontName='Helvetica-Bold')
body_style = ParagraphStyle('Body2', parent=styles['Normal'],
    fontSize=10, textColor=DARK, spaceAfter=6, leading=16)
bullet_style = ParagraphStyle('Bullet', parent=styles['Normal'],
    fontSize=10, textColor=DARK, spaceAfter=4, leading=15,
    leftIndent=14, bulletIndent=0)
small_style = ParagraphStyle('Small', parent=styles['Normal'],
    fontSize=9, textColor=GRAY, leading=14)

story = []

# ── HEADER ──────────────────────────────────────────────────────────────────
story.append(Paragraph("Decision Log", title_style))
story.append(Paragraph("Monday.com Business Intelligence Agent — Technical Assignment", sub_style))
story.append(HRFlowable(width="100%", thickness=2, color=PURPLE, spaceAfter=14))

# ── SECTION 1: Overview ──────────────────────────────────────────────────────
story.append(Paragraph("1. Project Overview", h1_style))
story.append(Paragraph(
    "This agent answers founder-level business intelligence queries using live data from Monday.com. "
    "It connects a conversational React interface to a Node.js backend powered by Google Gemini 1.5 Flash with "
    "structured tool-calling. Every query triggers live Monday.com GraphQL API calls — no data is cached or preloaded.",
    body_style))

# ── SECTION 2: Tech Stack ────────────────────────────────────────────────────
story.append(Paragraph("2. Tech Stack Decisions", h1_style))

table_data = [
    ['Component', 'Choice', 'Why'],
    ['LLM', 'Gemini 1.5 Flash', 'Free via Google AI Studio. Native function-calling. Fast (1-2s). Handles messy data reasoning well.'],
    ['Backend', 'Node.js + Express', 'Lightweight, async-native, perfect for API proxying and tool orchestration.'],
    ['Frontend', 'React + Vite', 'Fast dev cycle. React state handles streaming tool traces well. Vite gives instant HMR.'],
    ['Monday.com', 'GraphQL API', 'Single request fetches all columns. Pagination handled via cursor. More efficient than REST.'],
    ['Hosting', 'Render.com', 'Free tier, zero-config deploy from GitHub, live URL with no evaluator setup.'],
    ['Data Import', 'Node.js script', 'One-time script reads Excel files, normalizes messy data, uploads via Monday.com mutation API.'],
]

col_widths = [3.2*cm, 3.8*cm, 9.5*cm]
t = Table(table_data, colWidths=col_widths)
t.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), PURPLE),
    ('TEXTCOLOR', (0,0), (-1,0), colors.white),
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('FONTSIZE', (0,0), (-1,0), 9),
    ('FONTSIZE', (0,1), (-1,-1), 9),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [LIGHT, colors.white]),
    ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#ddddee')),
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('TOPPADDING', (0,0), (-1,-1), 5),
    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ('LEFTPADDING', (0,0), (-1,-1), 7),
]))
story.append(t)
story.append(Spacer(1, 10))

# ── SECTION 3: Architecture ──────────────────────────────────────────────────
story.append(Paragraph("3. Architecture & Agent Design", h1_style))
story.append(Paragraph(
    "The agent uses an agentic loop: Gemini decides which tool(s) to call based on the query, "
    "the backend executes live Monday.com GraphQL calls, results are returned to Gemini, "
    "which synthesizes a natural language answer. This loop continues until no more tool calls are needed.",
    body_style))

story.append(Paragraph("5 Tools Implemented:", h2_style))
tools_data = [
    ['Tool', 'Purpose'],
    ['get_deal_pipeline', 'Fetch deals filtered by sector, status, stage, owner'],
    ['get_work_orders', 'Fetch work orders filtered by sector, execution status, owner'],
    ['get_revenue_summary', 'Combined financial view across both boards'],
    ['get_owner_performance', 'Win rates, deal counts, pipeline value per owner'],
    ['get_sector_comparison', 'Compare all sectors by value, count, win rate'],
]
t2 = Table(tools_data, colWidths=[5.5*cm, 11*cm])
t2.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,0), DARK),
    ('TEXTCOLOR', (0,0), (-1,0), colors.white),
    ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
    ('FONTSIZE', (0,0), (-1,-1), 9),
    ('ROWBACKGROUNDS', (0,1), (-1,-1), [LIGHT, colors.white]),
    ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#ddddee')),
    ('TOPPADDING', (0,0), (-1,-1), 5),
    ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ('LEFTPADDING', (0,0), (-1,-1), 7),
]))
story.append(t2)

# ── SECTION 4: Data Resilience ───────────────────────────────────────────────
story.append(Paragraph("4. Data Resilience Strategy", h1_style))
story.append(Paragraph("The source data was intentionally messy. Key issues handled:", body_style))

issues = [
    ("Excel serial dates", "All date columns stored as serial numbers (e.g. 46079). Converted using formula: (serial - 25569) × 86400 × 1000 to Unix timestamp → ISO date string."),
    ("Duplicate header rows", "Skip any row where the first cell matches the header name ('Deal Name', 'Deal name masked') during both import and query processing."),
    ("Missing values", "All numeric aggregations use parseFloat() with || 0 fallback. Missing deal values and dates are counted and surfaced as data quality caveats in responses."),
    ("Inconsistent sector names", "Gemini's system prompt maps 'energy' queries to Mining + Powerline + Renewables. The tools also normalize sector strings to lowercase before filtering."),
    ("Blank first row (Work Orders)", "Work Orders sheet has an empty row 0 and headers in row 1. Import script skips row 0 and starts parsing from row 2."),
    ("Missing probability field", "47 deals have blank Closure Probability. These are included in counts but flagged in summaries."),
]

for title, desc in issues:
    story.append(Paragraph(f"<b>{title}:</b> {desc}", bullet_style))

# ── SECTION 5: Tradeoffs ─────────────────────────────────────────────────────
story.append(Paragraph("5. Key Tradeoffs", h1_style))

tradeoffs = [
    ("Gemini Flash vs Pro", "Flash chosen for speed and free quota. Pro would give better reasoning on ambiguous queries but adds latency and cost."),
    ("No data caching (by design)", "Assignment requires live API calls per query. Adds 1-3s latency per query but ensures always-fresh data."),
    ("Column ID mapping", "Monday.com column IDs are auto-generated slugs. Import script uses positional mapping (column index) rather than dynamic ID lookup, which is faster but requires board columns to be in the correct order."),
    ("Single-file React", "Frontend is a single App.jsx for simplicity and fast deployment. Production would split into components."),
]
for title, desc in tradeoffs:
    story.append(Paragraph(f"<b>{title}:</b> {desc}", bullet_style))

# ── SECTION 6: If I Had More Time ────────────────────────────────────────────
story.append(Paragraph("6. If I Had More Time", h1_style))
extras = [
    "MCP (Model Context Protocol) server for Monday.com — would earn bonus points per spec",
    "Chart rendering in the UI (bar charts for sector comparison, funnel viz for pipeline stages)",
    "Streaming responses with Server-Sent Events for real-time tool trace updates",
    "Monday.com webhook integration for proactive alerts (e.g. stale deals in pipeline)",
    "Date-range filtering ('this quarter') computed dynamically from current date",
    "Cross-board join: match Won deals → Work Orders to track deal-to-execution conversion rate",
]
for e in extras:
    story.append(Paragraph(f"• {e}", bullet_style))

story.append(Spacer(1, 12))
story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor('#ddddee')))
story.append(Spacer(1, 6))
story.append(Paragraph(
    "Total estimated build time: ~5.5 hours | Lines of code: ~900 | Monday.com API version: 2024-01",
    small_style))

doc.build(story)
print("Decision_Log.pdf created successfully")
