"""Build a static, self-contained evidence report from the frozen cohort."""
import csv
import hashlib
import html
import json
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
data = json.loads((ROOT / "cohort.json").read_text())
rows = data["rows"]
metadata = json.loads((ROOT / "metadata.json").read_text())
assert len(rows) == len({r["id"] for r in rows}) == 188


def esc(value):
    return html.escape(str(value))


def fmt(value, suffix=""):
    return "—" if value is None else f"{value:.2f}{suffix}"


def eligible(row, hours):
    window = row["windows"][str(hours)]
    return bool(window[0] and window[9])


def group(metric, predicate, hours, period=None):
    return [
        r for r in rows
        if eligible(r, hours) and r[metric] is not None
        and predicate(r[metric])
        and (period is None or period(r))
    ]


def hit_cell(items, hours, target=10):
    n = len(items)
    hits = sum(r["windows"][str(hours)][10] >= target for r in items)
    return f"{hits}/{n} ({hits / n * 100:.1f}%)" if n else "—"


def table(headers, body):
    return "<div class='scroll'><table><thead><tr>" + "".join(
        f"<th>{esc(h)}</th>" for h in headers
    ) + "</tr></thead><tbody>" + "".join(
        "<tr>" + "".join(f"<td>{esc(v)}</td>" for v in line) + "</tr>"
        for line in body
    ) + "</tbody></table></div>"


volume = "entry_fut_vol_mult"
trigger = "trigger_candle_volume_mult"
fut = "entry_fut_taker_net_buy_pct"
spot = "entry_spot_taker_net_buy_pct"
generic_stats = []
for label, test in [("Объём при входе <1x", lambda v: v < 1),
                    ("Объём при входе ≥1x", lambda v: v >= 1)]:
    one = group(volume, test, 1)
    six = group(volume, test, 6)
    generic_stats.append([
        label, hit_cell(one, 1, 5), hit_cell(six, 6),
        fmt(statistics.median(r["windows"]["6"][10] for r in six), "%"),
    ])
checks = []
for label, metric, split in [
    ("Фьючерсный taker", fut, 0),
    ("Спотовый taker", spot, 20),
    ("Объём закрытой импульсной свечи", trigger, 3),
]:
    lo, hi = group(metric, lambda v: v < split, 6), group(metric, lambda v: v >= split, 6)
    checks.append([label, f"<{split}", hit_cell(lo, 6), f"≥{split}", hit_cell(hi, 6)])
early_late = []
for label, pred in [
    ("До 20 сентября", lambda r: r["detected_at_utc"] < "2026-09-20"),
    ("С 20 сентября", lambda r: r["detected_at_utc"] >= "2026-09-20"),
    ("Только single_entry_v1", lambda r: r["entry_policy_version"] == "single_entry_v1"),
]:
    lo = group(volume, lambda v: v < 1, 6, pred)
    hi = group(volume, lambda v: v >= 1, 6, pred)
    early_late.append([label, hit_cell(lo, 6), hit_cell(hi, 6)])
strata = []
for label, positive in [("Taker >0", True), ("Taker ≤0", False)]:
    pred = lambda r: r[fut] is not None and (r[fut] > 0) == positive
    strata.append([label, hit_cell(group(volume, lambda v: v < 1, 6, pred), 6),
                   hit_cell(group(volume, lambda v: v >= 1, 6, pred), 6)])
coverage = []
for h in [1, 3, 6, 12, 24, 72]:
    valid = [r for r in rows if eligible(r, h)]
    coverage.append([f"{h} ч", len(valid), hit_cell(valid, h, 5), hit_cell(valid, h)])

case_headers = ["ID", "Токен", "Вход Dubai", "Статус", "Источник",
                "Цена-база", "База цены", "Fut taker %", "Spot taker %",
                "Объём при входе x", "Закрытая свеча x",
                "Пик 1ч %", "Пик 3ч %", "Пик 6ч %", "Пик 24ч %", "Пик 72ч %"]
cases = []
for r in rows:
    dt = datetime.fromisoformat(r["detected_at_utc"]).astimezone(timezone(timedelta(hours=4)))
    peaks = [fmt(r["windows"][str(h)][10]) if eligible(r, h) else "неполно"
             for h in [1, 3, 6, 24, 72]]
    cases.append([r["id"], r["symbol"], dt.strftime("%Y-%m-%d %H:%M"), r["status"],
                  r["snapshot_source"], r["basis_entry_price"], r["basis_price_source"],
                  fmt(r[fut]), fmt(r[spot]), fmt(r[volume]), fmt(r[trigger]), *peaks])

blocks = [
    "<h1>Impulse Buy: taker, объём и скорость отработки</h1>",
    "<p class='lead'><b>Частичное подтверждение гипотезы.</b> Объём при входе связан с более сильной быстрой реакцией. "
    "Для спотового или фьючерсного taker устойчивого правила «выше — лучше» не обнаружено. "
    "Повышение порога объёма закрытой импульсной свечи не улучшило результат.</p>",
    "<p>Production, SELECT-only. Снимок: " + esc(metadata["capture_asof_utc"]) +
    ". Все <b>188</b> уникальных tracker-linked fire-записей: 16 за июнь, 171 за сентябрь, 1 за октябрь. "
    "В августе сигналов нет, межмесячная оценка август → сентябрь невозможна. "
    "Включены старые стопы, отмены, 4 открытые и 2 нейтрально переклассифицированные записи. "
    "188 записей истории не означают 188 подтверждённых биржевых исполнений.</p>",
    "<h2>1. Объём в момент входа — наиболее заметная связь</h2>",
    table(["Группа", "+5% за 1ч", "+10% за 6ч", "Медианный пик за 6ч"], generic_stats),
    "<p>Spearman объём при входе ↔ пик: 0.31 / 0.38 / 0.33 для 1/3/6ч; "
    "95% symbol-cluster bootstrap-интервал для 6ч: [0.20; 0.45]. "
    "После удаления точных значений 1x направление связи сохраняется. "
    "Но entry_fut_vol_mult не равен объёму закрытой сигнальной свечи: это общий множитель "
    "сканера с возможной формирующейся свечой и cross-exchange корректировкой. "
    "<b>Это пока не доказательство влияния исключительно чистого BingX futures-объёма.</b></p>",
    "<h3>Проверка позднего периода и текущей модели входа</h3>",
    table(["Период", "<1x: +10% за 6ч", "≥1x: +10% за 6ч"], early_late),
    "<p>Направление сохраняется, но поздняя группа ≥1x — всего 5 наблюдений. "
    "Период разделён заранее по 20 сентября UTC; это не независимый будущий тест. "
    "Версия исполнения входа не является версией всех фильтров паттерна.</p>",
    "<h3>Та же связь внутри групп фьючерсного taker</h3>",
    table(["Фьючерсный taker", "<1x: +10% за 6ч", "≥1x: +10% за 6ч"], strata),
    "<h2>2. Taker и объём закрытой свечи</h2>",
    table(["Метрика", "Низкая группа", "+10% за 6ч", "Высокая группа", "+10% за 6ч"], checks),
    "<p>Futures taker ≥20%: 0/4 достигли +10% за 6ч. Четырёх случаев недостаточно, чтобы объявить "
    "этот режим плохим или вводить запрет. Bootstrap при четырёх одинаковых исходах не охватывает "
    "всю неопределённость возможной истинной частоты. "
    "Для спотового taker ≥20% заметна положительная тенденция, но интервал разницы частот на "
    "matched both-taker выборке включает ноль. "
    "Spearman taker ↔ пик за 6ч: futures 0.055, spot 0.102; оба интервала включают ноль. "
    "Совместно положительные taker: +10% за 6ч лишь 5/37 (13.5%).</p>",
    "<p>Закрытая 30m импульсная свеча ≥3x: 2/14 против 9/46 ниже 3x за 6ч; "
    "за 72ч — 4/14 против 24/39. "
    "Даже с fail-open для пропусков фильтр ≥3x удалил бы 9 из 44 быстрых +10%-достижений. "
    "Это ретроспективная чувствительность, не рекомендация. Измерение закрытой свечи есть у 61/188; "
    "все fire-события уже выбраны действующим порогом 1.5x, ниже него выводы невозможны.</p>",
    "<h2>3. Насколько быстро отрабатывает весь паттерн</h2>",
    table(["Окно", "Полное зрелое покрытие", "+5% пик", "+10% пик"], coverage),
    "<p>Длинные окна естественно дают больше пиков. За 6ч +10% встретилось у 44/185, но до "
    "касания −8% оно встретилось у 41/185; до −10% — у 42/185. "
    "Момент касания известен лишь до 15m-свечи, а не до точной минуты.</p>",
    "<h2>Метод и ограничения</h2><ul>",
    "<li>Только сохранённые входные значения из неизменяемых снимков. Futures taker: 148/188; "
    "spot taker: 94/188; общий объём при входе: 172/188; закрытая импульсная свеча: 61/188. "
    "Пропуски не заменены нулями и не восстановлены задним числом.</li>",
    "<li>Taker = (buy − sell)/(buy + sell) ×100; +20% net-buy соответствует 60% buy-share, "
    "а не 20% доле покупок. Сохранённый taker относится к последней доступной 15m-свече; "
    "источник/свежесть неоднородны, это не обязательно taker именно сигнальной 30m-свечи.</li>",
    "<li>Исходы — max high закрытых 15m-свечей от исходной цены входа. Исходная цена сохранена у 93; "
    "у 95 используется entry_price с явным флагом. Для старых split-позиций такая база может "
    "быть усреднённой. Свеча, содержащая сам вход, исключена во избежание pre-entry look-ahead.</li>",
    "<li>Для каждого окна отдельно проверены зрелость, все ожидаемые 15m-бакеты, края и отсутствие "
    "пропусков. Неполные окна не считаются неудачами и не входят в соответствующий знаменатель.</li>",
    "<li>Это одинаковые post-entry forward-окна, в том числе после закрытия позиции; не PnL "
    "и не обещание исполнимого тейка. Частичная pre-close sensitivity из дополнительных файлов "
    "не охватывает отмены и не используется как итог по всем исполненным сделкам.</li>",
    "<li>AKE, MARSCOIN и LSK с экстремальными длинными пиками не удалены из основной выборки. "
    "Есть отдельная чувствительность без них. LSK: пик 6ч 11.7%, 72ч 1786.2%; "
    "длинный выброс не доказывает ошибочность короткой реакции.</li>",
    "<li>Корреляция не доказывает причину. Пропуски, изменения фильтров, повторные токены, "
    "рыночный режим и малая поздняя выборка ограничивают уверенность.</li></ul>",
    "<h2>Вывод</h2><p>Обоснованный следующий объект наблюдения — <b>сохранение активности объёма "
    "в момент входа после импульса</b>, с точным источником, временем, фьючерсным инструментом и базой объёма. "
    "Не повышать автоматически объём закрытой свечи и не вводить taker-порог по этой выборке. "
    "Live-фильтры и выходы не изменены.</p>",
    "<h2>Все 188 сигналов</h2><p>Пик показан только для полного зрелого окна; «неполно» — "
    "неизвестный исход этого окна. «—» — входная метрика не записана. Время входа — Dubai (UTC+4).</p>",
    table(case_headers, cases),
    "<footer>Frozen cohort SHA-256: " + hashlib.sha256((ROOT / "cohort.json").read_bytes()).hexdigest() +
    ". Данные: tracked_signals → canonical pattern_decision_snapshots → pattern_backfill_candles, "
    "source bingx_15m. Без публичного повторного скачивания рынка.</footer>",
]
style = """
body{font:16px/1.55 system-ui,sans-serif;color:#17212d;background:#f4f6f9;margin:0}
main{max-width:1120px;margin:0 auto;background:white;padding:36px 40px}
h1{font-size:32px;line-height:1.2}h2{margin-top:36px;color:#123653}h3{margin-top:25px}
.lead{font-size:19px;background:#edf5fb;padding:20px;border-left:4px solid #286891}
.scroll{overflow:auto;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:10px 12px;border-bottom:1px solid #dae2e9;text-align:left;white-space:nowrap}
th{background:#edf1f6}tr:nth-child(even){background:#fafbfd}footer{font-size:12px;color:#5b6875;margin-top:28px}
@media(max-width:650px){main{padding:22px 15px}h1{font-size:26px}}
"""
document = "<!doctype html><html lang='ru'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Impulse Buy — все сигналы</title><style>" + style + "</style><main>" + "".join(blocks) + "</main></html>"
assert len(document.encode()) < 5_242_880
assert len(cases) == 188
(ROOT / "report.html").write_text(document)
with (ROOT / "all-signals-readable.csv").open("w", encoding="utf-8-sig", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(case_headers)
    writer.writerows(cases)
print(f"Report: {len(document.encode())} bytes; rows: {len(cases)}")