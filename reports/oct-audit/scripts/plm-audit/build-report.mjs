import fs from "node:fs";
import assert from "node:assert/strict";

// Report-only: all acquisition outputs are frozen inputs; no network or DB work.
const root = ".local/reports/";
const readJson = (area) =>
  JSON.parse(fs.readFileSync(`${root}plm-${area}-audit-2026-10-01.json`, "utf8"));
function readCsv(path) {
  const text = fs.readFileSync(path, "utf8");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if (c === "\n" && !quoted) {
      row.push(cell.replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert(!quoted);
  const header = rows.shift();
  return rows.map((r) => {
    assert.equal(r.length, header.length);
    return Object.fromEntries(header.map((h, i) => [h, r[i]]));
  });
}
const volume = readJson("volume");
const structure = readJson("ict");
const lifecycle = readJson("lifecycle");
const indicators = readCsv(`${root}plm-indicator-current-fixed72h-2026-10-01.csv`);
const cohort = readCsv(`${root}plm-cohort-2026-10-01.csv`);
const shadow = readCsv(`${root}plm-volume-shadow-class-counts-2026-10-01.csv`);
const e = (v) => String(v ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const pct = (v) => `${Number(v).toFixed(2).replace(".", ",")}%`;
const table = (heads, rows) => `<div class="scroll"><table><thead><tr>${heads.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${e(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const section = (id, title, content) => `<section id="${id}"><h2>${e(title)}</h2>${content}</section>`;
const details = (title, content) => `<details><summary>${e(title)}</summary>${content}</details>`;
const mature = volume.rows.filter((r) => r.forward72_mature);
const strong = mature.filter((r) => r.forward72_mature_and_strong);
assert.equal(cohort.length, 168);
assert.equal(mature.length, 15);
assert.equal(strong.length, 9);
assert.equal(indicators.length, 36);
assert.equal(lifecycle.cohort.forward_72h.thresholds["10"].complete_hit, 81);
const primaryCandidates = volume.candidateSummary.filter((r) => r.cohort === "single_entry_v1_fire_cohort_21");
assert.equal(primaryCandidates.length, 8);
const volumeTable = (rows) => table(
  ["Условие сохранения", "Убрано входов", "Сохранено пиков ≥10%", "Потеряно сильных пиков", "Убрано STOP LOSS", "Убрано БУ", "Убрано неполных окон"],
  rows.map((r) => [r.candidate, `${r.removed}/${r.signals}`, `${r.strong72Retained}/${r.strong72Total}`, r.strong72Lost, `${r.stopLossRemoved}/${r.stopLossTotal}`, `${r.buStopRemoved}/${r.buStopTotal}`, `${r.censored72Removed}/${r.censored72Total}`]));
const indicatorTable = (rows) => table(
  ["TF / условие сохранения", "Измерено / неизвестно", "Убрано / 21", "Сохранено / 9", "Потеряно / 9", "Стопов убрано / 1", "Неполных окон убрано / 6"],
  rows.map((r) => [`${r.timeframe}: ${r.fixed_candidate_cut}`, `${r.eligible_values} / ${r.unknown_retained}`, r.removed_total, r.strong72_retained, r.strong72_removed, r.exact_stop_removed, r.partial_censored_removed]));
const headlineIndicators = new Set(["15m|RSI5 <=70", "4h|Williams %R(21) <=-20", "30m|ADX14 >=30", "4h|ATR percentile <=75", "1h|BB bandwidth percentile <=50", "1h|abs aVWAP distance <=2 ATR", "4h|abs aVWAP distance <=2%"]);
const featureNames = {
  ict_imbalance_displacement_recent: "Displacement любого направления",
  luxalgo_bos_bullish_recent: "Бычий BOS, последние закрытые бары",
  luxalgo_choch_bullish_recent: "Бычий CHoCH",
  luxalgo_fvg_bullish_active: "Активный бычий FVG",
  luxalgo_demand_ob_within_1atr: "Demand OB в пределах 1 ATR",
  ict_dliq_dynamic_sweep_recent: "Динамический liquidity sweep",
};
const structureTable = (rows) => table(
  ["TF / признак для сохранения", "Убрано / 21", "Сохранено / 9", "Потеряно / 9", "Стопов убрано / 1", "Неполных окон убрано / 6"],
  rows.map((r) => [`${r.timeframe}: ${featureNames[r.feature] ?? r.feature}`, r.sampleReductionIfUnknownPasses, r.forward72StrongRetained, r.forward72StrongRemoved, r.exactStopLossRemoved, r.forward72CensoredRemoved]));
const dubaiMonth = (s) => new Date(new Date(`${s.replace(" ", "T")}Z`).getTime() + 4 * 3600000).toISOString().slice(0, 7);
const peak = (r) => 100 * (Number(r.peak_price) / Number(r.original_entry_price || r.entry_price) - 1);
const median = (a) => { const x = a.slice().sort((a, b) => a - b); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; };
const monthlyRows = ["2026-08", "2026-09"].map((m) => {
  const entered = cohort.filter((r) => dubaiMonth(r.detected_at) === m);
  const closed = cohort.filter((r) => r.closed_at && dubaiMonth(r.closed_at) === m);
  const pnl = closed.map((r) => Number(r.pnl_percent));
  const s = (status) => closed.filter((r) => r.status === status).length;
  return [m, entered.length, (entered.length / (m.endsWith("08") ? 31 : 30)).toFixed(2), closed.length, `${closed.filter((r) => peak(r) >= 10).length}/${closed.length}`, s("stop_loss"), s("bu_stop"), s("profit"), s("expired"), s("cancelled"), pct(pnl.reduce((a, b) => a + b, 0)), pct(pnl.reduce((a, b) => a + b, 0) / pnl.length), pct(median(pnl))];
});
const body = [
  section("answer", "Итог: готового нового фильтра нет", `<p>По проверенным объёмам, цене, CVD, OI, taker, индикаторам и ICT/LuxAlgo не найдено достаточно подтверждённого нового ограничения для live-входов PLM. Условия, убирающие единственный стоп в сопоставимой текущей части, обычно теряют несколько сильных движений.</p><p><strong>Есть только наблюдательные гипотезы по удалённости от aVWAP.</strong> На этом маленьком срезе они сохраняют известные пики и убирают AGLD, но это один отрицательный случай, существенная доля неизвестных значений и незавершённых будущих окон. Их не называю готовыми фильтрами и не внедряю.</p><div class="note">Основной критерий качества входа — пик ≥10% за фиксированные 72 часа после сигнала, включая движение после закрытия. Реализованный PnL, стоп до будущего пика и качество сопровождения показаны отдельно. Сильное движение не исчезает из анализа из-за БУ или отмены.</div>`),
  section("cohort", "Какие выборки сравнивались", table(
    ["Выборка", "Входов", "Закрыто / открыто", "Записанный пик ≥10% до закрытия", "Полные 72h окна", "72h пик ≥10%"],
    [["Вся история, без трёх нейтральных reclassified", 168, "162 / 6", "60/162 закрытых", 162, "81/162 — 50,0%"],
      ["Legacy: без single-entry метки", 147, "147 / 0", "54/147", 147, `${81 - strong.length}/147`],
      ["single_entry_v1", 21, "15 / 6", "6/15 — 40,0%", 15, "9/15 — 60,0%"]]) +
    `<p>Одинаковое число 162 закрытых позиций и 162 полных 72h окон не означает одинаковый состав. У JASMY позиция открыта, но окно уже полное. ARX закрылся в БУ, но окно имеет только 144/288 свечей. Ещё пять сигналов имеют 72/48/24/24/0 свечей. Эти шесть неполных окон не считаются неудачами.</p><p>single_entry_v1 обозначает модель входа, а не версию всех scanner-гейтов. В 21 fire-time снимке есть основные входные метрики; только 15 соответствуют всему нынешнему набору условий по записанным значениям. Input-parity не доказывает, что исторически действовала именно эта версия.</p>`),
  section("months", "Август против полного сентября — Dubai", table(
    ["Месяц", "Входов в месяце", "Входов / день", "Закрытий в месяце", "Записанных пиков ≥10%", "Stop", "БУ", "Profit", "Expired", "Cancel", "Сумма raw PnL, п.п.", "Средний PnL", "Медиана PnL"], monthlyRows) +
    `<p>По месяцу закрытия доля записанных сильных пиков практически одинакова: август 23/62 = 37,1%; сентябрь 36/97 = 37,1%. Стопов стало 21/97 против 11/62. По месяцу входа частота выросла с 67 до 96 сигналов. Это не доказательство ухудшения или улучшения конкретного фильтра: месяцы смешивают правила и рыночные режимы.</p><small>Календарный месяц закрытия и месяц входа не объединяются. Raw PnL — вторичная метрика; сумма — сумма процентов позиций, не прибыль депозита и не сложный процент.</small>`),
  section("winners", "Девять сильных движений в single-entry 72h окне", table(
    ["Сигнал / вход, UTC", "Пик за 72h", "Статус на срезе", "Пик, записанный в позиции"], strong.map((r) => [
      `${r.symbol} · ${String(r.detected_at).slice(0, 16)}`, pct(r.forward72_peak_pct), r.status, pct(r.tracker_peak_pct)])) +
    `<p>ORDI, первый ATH и NMR добавляются к шести сильным tracker-пикам именно потому, что наблюдение не обрывается на БУ. NMR после БУ дал +53,42%. У PHA 72h пик +22,52%, а записанный максимум позиции +81,00% находится в другом, более длинном окне; эти величины не подменяются друг другом.</p>`),
  section("volume", "Объёмы, рост цены, OI, CVD и taker: цена каждого ограничения", volumeTable(primaryCandidates) +
    `<p>Здесь 21 вход, девять полных сильных 72h движений, один STOP LOSS и восемь БУ. Удалённые неполные окна показаны отдельно: их будущий результат неизвестен.</p><p>Spot volume ≥1,5x и рост 3h ≥2% убирают AGLD, но теряют по четыре сильных движения из девяти. Cap spot volume ≤2x также теряет четыре, не убирая стоп. OI30m &lt;2% оставляет все 21 входа, поэтому в этом срезе вообще не фильтрует.</p>` +
    details("Проверка на subset из 15 входов, совместимых с нынешними условиями", volumeTable(volume.candidateSummary.filter((r) => r.cohort.includes("parity"))) +
      `<p>На subset spot ≥1,5x теряет 3/8 полных сильных пиков; p3h ≥2% — 4/8; оба убирают один стоп. p3h ≤3% сохраняет 8/8, но стоп не убирает и исключает ещё не завершённый ARX. В маленьком holdout cap spot ≤2x теряет оба сильных пика. Ни одно число не является доказанным out-of-sample результатом.</p>`)),
  section("coverage", "Что известно в момент входа, а что отсутствует", `<ul><li>21/21: p24h, p3h, frozen spot multiplier, SNF, CVD, OI30m, Futures Taker и futures volume, источник signal_fire.</li><li>p24h 5,65–14,30%; p3h 1,50–3,98%; spot multiplier 1,166–2,498x. Все соответствуют нынешним ценовым, spot-volume и SNF условиям.</li><li>Число положительных CVD: один TF у шести входов; два у трёх; три у четырёх; четыре у восьми. Шесть исторических расхождений с нынешним ≥2 CVD не объявляются багом без версии применявшихся правил.</li><li>Spot taker есть у 13/21; volume/mcap у 19/21. BTC 24h, detection lag и confirmation lag отсутствуют. BTC dominance не заменяет изменение цены BTC.</li><li>OB ratio и остальные сохранившиеся метрики — наблюдения, не доказательство точной support-wall структуры. Нет оснований придумывать цену поддержки, retest или отсутствующий рыночный контекст.</li></ul>`),
  section("shadows", "Теневые OI30m и Futures Taker: выборка ещё недостаточна", `<p>В single-entry части все 21 имеют сохранённый OI30m класс below_2: перегретая ≥2% группа пустая. Futures Taker ≥20%: четыре входа, два закрытых — KSM profit и 1000CAT БУ — и два открытых. Стопов в этой группе нет.</p><p>В legacy части реально сохранённые классы ≥20% taker имеют восемь закрытых входов; ≥2% OI30m — четыре. Их не переклассифицировали по поздним числовым метрикам и не смешивали с нынешней моделью. Даже весь сохранённый taker ≥20% forward-class имеет лишь десять закрытых исходов, а не требуемые двадцать.</p>` +
    details("Сохранённые immutable shadow-классы: все группы", table(Object.keys(shadow[0] ?? {}), shadow.map((r) => Object.values(r)))) +
    `<p>Разрезы taker 20–30% и &gt;30% слишком малы для вывода. OI/taker остаются телеметрией, не новым veto входа.</p>`),
  section("indicators", "Индикаторы: полный 72h peak вместо PnL закрытия", indicatorTable(indicators.filter((r) => headlineIndicators.has(`${r.timeframe}|${r.fixed_candidate_cut}`))) +
    `<p>RSI5 ≤70, Williams ≤−20, ADX ≥30, ATR cap и узкие Bollinger-полосы в целом отсекают сильные движения. Полная таблица всех 36 фиксированных срезов дана ниже; неизвестные значения сохраняются как unknown/fail-open.</p>` +
    details("Все 36 срезов: четыре таймфрейма", indicatorTable(indicators)) +
    `<h3>aVWAP — гипотеза, не рекомендация к внедрению</h3><p>1h |distance| ≤2 ATR убирает только AGLD и сохраняет 9/9 наблюдённых пиков, но у пяти входов расстояние неизвестно. 4h |distance| ≤2% сохраняет 9/9 и убирает AGLD; при этом удаляет девять входов, пять из них имеют незавершённые будущие окна, а шесть неизвестных проходят. У действительно captured телеметрии всего четыре полных сильных движения; остальные пять сильных случаев не являются такой проверкой aVWAP. Один стоп — недостаточный контроль для нового правила.</p><h3>Происхождение индикаторов</h3><p>В текущей части 15 captured и шесть reconstructed строк. У captured девять полных окон и четыре сильных движения; у reconstructed шесть полных окон и пять сильных. Исторические значения не выдаются за известные на fire. Закрытие входной свечи проверено относительно detected_at.</p><p>В расширенной истории из 60 tracker-пиков, например, 1h Bollinger cap ≤50 теряет 51 и убирает 30/33 стопов — высокая доля удалённых стопов не делает такой cap полезным. Старый вывод Williams по сохранению 20/21 прибыльных закрытий не заменяет нынешнюю оценку по пикам.</p><small>ATR/Bollinger percentiles с названием 60d фактически используют до 1 440 наблюдений: примерно 15 дней на 15m, 30 дней на 30m, 60 дней на 1h. Body% индикаторной свечи — доля диапазона, не процент роста тела как у IB. Порог «тело ≥3%» на PLM без соответствующего контракта не переносился.</small>`),
  section("structure", "ICT/LuxAlgo: структура не дала приемлемого нового гейта", structureTable(structure.forward72Tradeoffs.filter((r) => Object.hasOwn(featureNames, r.feature) && ["ict_imbalance_displacement_recent", "luxalgo_bos_bullish_recent", "luxalgo_choch_bullish_recent", "luxalgo_fvg_bullish_active", "luxalgo_demand_ob_within_1atr"].includes(r.feature))) +
    `<p>Все 52 структурных среза, удаляющих AGLD, теряют от четырёх до девяти сильных 72h движений и снимают 10–21 вход. Простое наличие бычьего FVG или displacement также не показывает достаточной пользы по стопу.</p><p>Использованы закрытые до входа 1h/4h свечи и локальные ICT/LuxAlgo event replay. BOS, CHoCH, FVG и OB — source-derived closed-bar приближение, не бит-в-бит результат Pine/TradingView. MSS, canonical dealing range, premium/discount, реальные S/R уровни и retest этим replay не доказаны и не подменялись придуманными правилами.</p>` +
    details(`Все ${structure.forward72Tradeoffs.length} структурных срезов`, structureTable(structure.forward72Tradeoffs))),
  section("paths", "Стопы, отмены и БУ: потенциал входа отдельно от сопровождения", `<p>Во всей истории за полный entry+72h путь 81/162 достигли +10%, 48/162 — +20%, 31/162 — +30%. Медианный максимум +10,09%; медианная просадка −7,81%. Большой будущий пик не означает безопасный путь к нему.</p><p>У 138 закрытых позиций есть хотя бы один пост-close бар внутри полного 72h окна. После закрытия 58/138 снова или впервые достигли +10% от исходной цены входа. Из них двадцать ранее не имели записанного пика +10%: два стопа, одна отмена и 17 БУ. Это не двадцать доказанных исполнимых прибыльных сделок.</p>` +
    table(["Исторический вход", "Исход", "Пик после закрытия внутри 72h", "Что это означает"], [
      ["ON, 29 июля", "STOP LOSS −8,56%", "+19,34%", "Сильное будущее движение после стопа"],
      ["PORTAL, 25 августа", "STOP LOSS −8,64%", "+31,47%", "Сильное будущее движение после стопа"],
      ["SEI, 20 августа", "Cancel −1,06%", "+20,68%", "Историческая отмена пропустила будущий рост"]]) +
    `<p>Все пять исторических отмен имеют stale_oi_vol. Нынешняя автоматическая отмена PLM отключена; эти случаи не используются как доказательство ошибки нынешней отмены. В текущей части отмен нет.</p><p>Единственный текущий STOP LOSS — AGLD с raw PnL −2,76% через четыре дня. Счётчик использует записанный outcome-status; не утверждается, что это исполнение полного исходного −8% стопа. Runner/core условия IB на PLM не переносились.</p>`),
  section("backfill", "Бэкфилл отвергнутых решений: большой объём, слабая причинная сопоставимость", `<p>110 525 rejected/blocked записей: 110 435 rejected и 90 blocked. Повторные сканы не считаются отдельными сделками. После symbol-UTC-day дедупликации — 11 238 дней по 607 токенам; 10 527 имеют положительную цену решения, 711 остаются no-price/unknown.</p>` +
    table(["Выборка", "Complete", "Partial", "Unavailable"], [["Все rejected snapshots на отдельном inventory-срезе", 24615, 1909, 83911], ["Самое раннее price-valid решение каждого symbol-day", 2604, 243, 7680]]) +
    `<p>66 647 сырых событий — legacy p24h_range без версии правил и без нужного decision-time набора p24h/p3h/spot/SNF/CVD. По ним нельзя заключить, сколько хороших входов удаляет нынешний p24h cap, или ослабить его.</p><p>Ранний положительный price-event выбирается по времени, затем ID; день без любой положительной цены остаётся неизвестным. Даже после этого разные дни и токены с пересекающимися окнами не становятся независимыми сделками. First-fail причина не доказывает эффект одного изолированного гейта. Status backfill асинхронен; отдельный inventory-срез сделан позднее frozen исходов и не смешивается с ними.</p>`),
  section("method", "Метод, ограничения и проверка", `<ul><li>Исходы заморожены в CSV: обнаружения с 28 июля по 1 октября 2026; дата входа и закрытия различаются. Нейтральные reclassified исключены. Календарные месяцы — Asia/Dubai; timestamps входных и candle данных — UTC.</li><li>72h endpoint — максимум high сохранённых post-decision 15m свечей; входная цена original_entry_price, если положительная, иначе frozen entry_price. Не используется сниженная split-average цена. В 31 legacy случае snapshot price отличается от выбранной исходной цены; расчёт нормализован по одному правилу.</li><li>Pre-entry признаки не используют свечи, закрывшиеся после обнаружения. Post-entry путь намеренно использует последующее движение, включая бары после выхода. Полные будущие окна определяются свечным покрытием, не статусом позиции.</li><li>OHLC не устанавливает точный порядок high/low внутри свечи, исполнимость стопа/входа, комиссии и проскальзывание. Никакого восстановления отсутствующих исторических CVD/OI, BTC или anchors не выполнялось.</li><li>Пороги объёмов/цены и индикаторов заданы для одиночных проверок; комбинации, OB distance и aVWAP остаются exploratory. Среди множества проверок не выбирается удачный случай как готовый live-фильтр.</li><li>Публичный ICT candle replay потребовал 84 запроса: после ошибки формирования первого отчёта был повторён проход. Это превысило задуманный суммарный предел 48; повторных market-запросов при финальной сборке и коррекции endpoint не было.</li><li>Сверены membership, знаменатели, source/provenance, месяцы и закрытые/неполные окна. Offline структурные тесты: 7/7. Этот HTML содержит все таблицы и стили и не делает никаких запросов.</li></ul><p>Источники: frozen cohort CSV; отдельные volume, indicator, ICT и lifecycle audit JSON/CSV/Markdown; сохранённые production decision snapshots и 15m backfill. Промежуточные production SELECT-only срезы — 1 октября примерно 04:36–04:51 UTC. Все исходные выгрузки и воспроизводимые запросы сохранены в проекте.</p><p><strong>Live-правила, исходы, БД, история позиций, workflow и публикация не менялись.</strong> Отдельно полезно сохранять версию применявшегося набора правил PLM: сейчас это главный предел сопоставимости исторических входов, а не основание срочно менять пороги.</p>`),
].join("\n");
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PLM — полный анализ по пикам</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f3f6f7;color:#183340;font:16px/1.65 system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:40px 24px 70px}header{padding:12px 0 24px;border-bottom:2px solid #184a5d}h1{font-size:36px;line-height:1.16;max-width:780px}h2{font-size:25px;line-height:1.3}h3{font-size:19px}p,li{max-width:940px}section{margin-top:26px;padding:26px;background:white;border:1px solid #d7e1e5;border-radius:8px;scroll-margin-top:15px}.meta,small,footer{color:#526b77}nav{display:flex;gap:10px 18px;flex-wrap:wrap;padding:20px 0 0}nav a{color:#14566d;text-decoration:underline;font-size:14px}a:focus-visible,summary:focus-visible{outline:3px solid #3c8199;outline-offset:4px}.note{background:#e9f3f6;border-left:4px solid #23647a;padding:14px 18px}.scroll{overflow-x:auto;max-width:100%}table{width:100%;border-collapse:collapse;font-size:13px;line-height:1.45;margin:14px 0}th,td{text-align:left;vertical-align:top;padding:11px 9px;border-bottom:1px solid #dbe5e9}th{background:#eef4f6;font-weight:650}tr:nth-child(even) td{background:#fafcfd}summary{cursor:pointer;color:#12576d;font-weight:650;padding:12px 0}details{margin:15px 0;border-top:1px solid #dbe5e9}small{display:block;font-size:13px}footer{font-size:13px;margin-top:24px}@media(max-width:640px){main{padding:22px 12px 45px}h1{font-size:29px}section{padding:18px 14px}h2{font-size:22px}table{font-size:12px}}@media print{body{background:white}main{max-width:none;padding:0}section{border:0;padding:0;margin-top:24px}.scroll{overflow:visible}nav{display:none}th,td{padding:6px}details:not([open]){display:block}}
</style></head><body><main><header><p class="meta">PRICE LED MOMENTUM · PRODUCTION AUDIT · 1 ОКТЯБРЯ 2026</p><h1>Полный разбор PLM: сильные пики, цена фильтрации и сопровождение</h1><p>Вся история и сопоставимая single-entry часть разделены. Основной endpoint — полный 72-часовой пик; PnL закрытия не определяет качество входа.</p><nav aria-label="Разделы отчёта">${[["answer","Вывод"],["cohort","Выборки"],["months","Месяцы"],["volume","Входные условия"],["indicators","Индикаторы"],["structure","ICT/LuxAlgo"],["paths","Сопровождение"],["backfill","Бэкфилл"],["method","Метод"]].map(([id,t]) => `<a href="#${id}">${t}</a>`).join("")}</nav></header>${body}<footer>Самодостаточный статический отчёт. Данные — сохранённый read-only срез, не биржевой backtest и не прогноз.</footer></main></body></html>`;
assert(Buffer.byteLength(html) < 5242880);
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync("reports/plm-full-audit-2026-10-01.html", html);
console.log(JSON.stringify({ file: "reports/plm-full-audit-2026-10-01.html", bytes: Buffer.byteLength(html), volumeCuts: primaryCandidates.length, indicatorCuts: indicators.length, structureCuts: structure.forward72Tradeoffs.length, complete72h: mature.length, strong72h: strong.length }));