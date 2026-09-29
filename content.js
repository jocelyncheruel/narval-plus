(() => {
  "use strict";

  if (window.top !== window || document.documentElement.dataset.narvalOverlayLoaded) return;
  document.documentElement.dataset.narvalOverlayLoaded = "true";

  const APP_ID = "narval-next-root";
  const CACHE_SCHEMA = 4;
  const RANK_CONFIG = globalThis.NARVAL_RANKING_CONFIG || {apiUrl:"",minimumParticipants:5};
  const UPDATE_CONFIG = globalThis.NARVAL_UPDATE_CONFIG || {};
  let originalTitle = document.title;
  let model = null;
  let selectedPeriod = "semester:0";
  let activeView = "dashboard";
  let syncStatus = { state: "idle", message: "" };
  let rankingSettings = { enabled:false, contributorId:"", deviceId:"", deviceToken:"" };
  let rankingState = { state:"disabled", periodKey:"", overall:null, competencies:{}, modules:{}, message:"" };
  let rankingCache = {};
  let deviceState = { devices:[], currentDeviceIdHash:"", message:"" };
  let pairingState = { code:"", expiresAt:"", message:"" };
  let pairingPoll = 0;
  let updateState = { available:false, version:"", title:"", message:"", url:"", mandatory:false, snoozedUntil:0 };
  let animatedUpdateVersion = "";

  const clean = (value = "") => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const number = (value) => {
    const match = clean(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  };
  const display = (value, suffix = "") => value === null || value === undefined || value === "" ? "—" : `${value}${suffix}`;
  const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));

  function textLines(element) {
    return (element?.innerText || "").split("\n").map(clean).filter(Boolean);
  }

  function valueAfter(lines, label) {
    const i = lines.findIndex(line => line.toLowerCase().startsWith(label.toLowerCase()));
    if (i < 0) return null;
    const inline = clean(lines[i].slice(label.length));
    return inline && inline !== ":" ? inline.replace(/^:\s*/, "") : lines[i + 1] || null;
  }

  function parseEvaluation(node) {
    const lines = textLines(node);
    const ignored = /^(Coef\.?|Max\. promo\.|Moy\. promo\.|Min\. promo\.|Poids )/i;
    const title = lines.find(line => !ignored.test(line) && !/^\d+[.,]\d+$/.test(line)) || "Évaluation";
    const titleIndex = lines.indexOf(title);
    const gradeText = lines[titleIndex + 1] || "";
    const grade = /^\d{1,2}(?:[.,]\d+)?$/.test(gradeText) ? number(gradeText) : null;
    return {
      title,
      grade,
      coefficient: number(valueAfter(lines, "Coef")),
      promotion: {
        max: number(valueAfter(lines, "Max. promo.")),
        average: number(valueAfter(lines, "Moy. promo.")),
        min: number(valueAfter(lines, "Min. promo."))
      },
      weights: lines.filter(line => /^Poids /i.test(line)).map((line, index) => ({
        competency: clean(line.replace(/^Poids /i, "")),
        value: number(lines[lines.indexOf(line, index) + 1])
      }))
    };
  }

  function evaluationsForModule(node) {
    const direct = [...node.querySelectorAll(".eval")];
    if (direct.length) return direct;
    const found = [];
    let sibling = node.nextElementSibling;
    while (sibling && !sibling.matches(".module")) {
      if (sibling.matches(".eval")) found.push(sibling);
      found.push(...sibling.querySelectorAll(".eval"));
      sibling = sibling.nextElementSibling;
    }
    if (found.length) return [...new Set(found)];
    const parent = node.parentElement;
    if (parent && parent.querySelectorAll(".module").length === 1) {
      return [...parent.querySelectorAll(".eval")];
    }
    return [];
  }

  function parseModule(node, kind) {
    const title = clean(node.querySelector("h3")?.textContent || textLines(node)[0]);
    const split = title.split(/\s+-\s+/);
    const code = split.shift() || title;
    const evaluations = evaluationsForModule(node).map(parseEvaluation);
    return {
      code,
      title: split.join(" - ") || title,
      kind,
      evaluations,
      calculatedAverage: calculateAverage(evaluations)
    };
  }

  function calculateAverage(evaluations) {
    const graded = evaluations.filter(item => item.grade !== null);
    const weighted = graded.filter(item => item.coefficient !== null && item.coefficient > 0);
    const weightTotal = weighted.reduce((sum, item) => sum + item.coefficient, 0);
    if (weightTotal > 0) {
      return Number((weighted.reduce((sum, item) => sum + item.grade * item.coefficient, 0) / weightTotal).toFixed(2));
    }
    if (!graded.length) return null;
    return Number((graded.reduce((sum, item) => sum + item.grade, 0) / graded.length).toFixed(2));
  }

  function parseCompetency(node) {
    const lines = textLines(node);
    const heading = clean(node.querySelector("h3")?.textContent || lines[0]);
    const split = heading.split(/\s+-\s+/);
    const summary = lines.find(line => /Moyenne/i.test(line)) || "";
    const rank = summary.match(/Rang\s*:\s*([^B]+)/i)?.[1]?.trim() || null;
    const ects = summary.match(/ECTS\s*:\s*([\d.,]+)\s*\/\s*([\d.,]+)/i);
    const modules = [...node.querySelectorAll(".syntheseModule")].map(item => {
      const itemLines = textLines(item);
      const label = itemLines[0] || "";
      return { label, grade: number(itemLines[1]), coefficient: number(valueAfter(itemLines, "Coef.")) };
    });
    const weightedModules = modules.filter(item => item.grade !== null && item.coefficient !== null && item.coefficient > 0);
    const weightTotal = weightedModules.reduce((sum, item) => sum + item.coefficient, 0);
    const calculatedAverage = weightTotal > 0 ? Number((weightedModules.reduce((sum, item) => sum + item.grade * item.coefficient, 0) / weightTotal).toFixed(2)) : null;
    const officialAverage = number(summary.match(/Moyenne\s*:\s*([\d.,]+)/i)?.[1] || "");
    return {
      code: split.shift() || heading,
      title: split.join(" - ") || heading,
      average: officialAverage,
      calculatedAverage,
      rank,
      ects: ects ? { earned: number(ects[1]), total: number(ects[2]) } : null,
      modules
    };
  }

  function parseSemester(root, label, index) {
    const info = root.querySelector(".infoSemestre");
    const infoLines = textLines(info);
    const title = clean(root.querySelector(".enteteSemestre h2, .enteteSemestre, h2")?.textContent || label);
    const rankRaw = valueAfter(infoLines, "Rang") || "";
    const rankParts = rankRaw.match(/(\d+)\s*\/\s*(\d+)/);
    const ectsRaw = clean(root.querySelector(".ects")?.textContent || "");
    const ectsParts = ectsRaw.match(/([\d.,]+)\s*\/\s*([\d.,]+)/);
    const allModules = [...root.querySelectorAll(".module")];
    const saeArea = [...root.querySelectorAll("section")].find(s => /^SA[ÉE]/i.test(clean(s.querySelector("h2")?.textContent || "")));
    const saeNodes = saeArea ? [...saeArea.querySelectorAll(".module")] : [];
    const saeSet = new Set(saeNodes);
    const semester = {
      index,
      label,
      title,
      average: number(valueAfter(infoLines, "Moyenne")),
      rank: rankParts ? { position: Number(rankParts[1]), total: Number(rankParts[2]) } : null,
      promotion: {
        max: number(valueAfter(infoLines, "Max. promo.")),
        average: number(valueAfter(infoLines, "Moy. promo.")),
        min: number(valueAfter(infoLines, "Min. promo."))
      },
      ects: ectsParts ? { earned: number(ectsParts[1]), total: number(ectsParts[2]) } : null,
      decision: clean(root.querySelector(".decision_annee, .decision")?.textContent || ""),
      enrollmentDate: clean(root.querySelector(".dateInscription")?.textContent || ""),
      competencies: [...root.querySelectorAll(".ue")].map(parseCompetency).filter(item => !/^bonus$/i.test(clean(item.code)) && !/^bonus$/i.test(clean(item.title))),
      resources: allModules.filter(n => !saeSet.has(n)).map(n => parseModule(n, "resource")),
      saes: saeNodes.map(n => parseModule(n, "sae"))
    };
    const officialAverages = new Map();
    root.querySelectorAll(".syntheseModule").forEach(item => {
      const lines = textLines(item);
      const code = clean((lines[0] || "").split(/\s+-\s+/)[0]);
      const average = number(lines[1]);
      if (code && average !== null && !officialAverages.has(code)) officialAverages.set(code, average);
    });
    [...semester.resources, ...semester.saes].forEach(module => {
      module.officialAverage = officialAverages.get(module.code) ?? null;
    });
    const calculableCompetencies = semester.competencies.filter(item => (item.calculatedAverage ?? item.average) !== null);
    const ectsWeight = calculableCompetencies.reduce((sum, item) => sum + (item.ects?.total || 0), 0);
    semester.calculatedAverage = calculableCompetencies.length
      ? Number((calculableCompetencies.reduce((sum, item) => sum + (item.calculatedAverage ?? item.average) * (ectsWeight > 0 ? item.ects.total : 1), 0) / (ectsWeight > 0 ? ectsWeight : calculableCompetencies.length)).toFixed(2))
      : null;
    return semester;
  }

  function parseStudent(root) {
    const lines = textLines(root.querySelector(".info_etudiant, .infoEtudiant"));
    const idLine = lines.find(line => /Numéro étudiant/i.test(line)) || "";
    const civilite = root.querySelector(".civilite");
    const identityCopy = civilite?.cloneNode(true);
    identityCopy?.querySelector(".dateNaissance")?.remove();
    const rawIdentity = clean(identityCopy?.textContent || lines[0] || "Étudiant");
    const withoutTitle = rawIdentity.replace(/^(M\.|Mme\.?|Mlle\.?)\s*/i, "").replace(/\s*\([^)]*\)\s*/g, " ").trim();
    const nameParts = withoutTitle.split(/\s+/).filter(Boolean);
    const firstName = nameParts.length > 1 ? nameParts.pop() : "";
    const surname = nameParts.join(" ");
    const titleCase = value => value.toLocaleLowerCase("fr-FR").replace(/(^|[-'’\s])\p{L}/gu, letter => letter.toLocaleUpperCase("fr-FR"));
    const fullLabel = clean(`${titleCase(firstName)} ${titleCase(surname)}`) || rawIdentity;
    return {
      name: titleCase(firstName) || fullLabel,
      fullLabel,
      birthDate: clean(root.querySelector(".dateNaissance")?.textContent || "").replace(/^né[e]? le\s*/i, ""),
      studentNumber: idLine.match(/Numéro étudiant\s*:\s*([^\s-]+)/i)?.[1] || "",
      ine: idLine.match(/Code INE\s*:\s*(\S+)/i)?.[1] || "",
      program: lines.find(line => /^BUT|^Licence|^Master|^DUT/i.test(line)) || "Formation",
      photo: root.querySelector(".studentPic")?.src || ""
    };
  }

  function parseAbsences() {
    const block = document.querySelector(".absences");
    if (!block) return { rows: [], justified: null, unjustified: null, delays: null };
    const cells = [...block.querySelectorAll(".toutesAbsences > div")];
    const dataCells = cells.filter(cell => !cell.classList.contains("entete"));
    const rows = [];
    for (let i = 0; i + 4 < dataCells.length; i += 5) {
      const values = dataCells.slice(i, i + 5);
      const date = clean(values[0].textContent || "");
      if (!date || date === "/") continue;
      const statusNode = values[4];
      const status = statusNode.classList.contains("justifie") ? "Justifiée" : statusNode.classList.contains("retard") ? "Retard" : statusNode.classList.contains("absent") ? "Non justifiée" : clean(statusNode.textContent || "");
      const timeRange = clean(values[1].textContent || "");
      const durationMinutes = absenceDurationMinutes(timeRange);
      rows.push({ date, timeRange, durationMinutes, hours: formatDuration(durationMinutes, timeRange), subject: clean(values[2].textContent || ""), teacher: clean(values[3].textContent || ""), status });
    }
    const totalCells = [...block.querySelectorAll(".totauxAbsences > div")].filter(cell => !cell.classList.contains("entete"));
    return {
      rows,
      justified: clean(totalCells[0]?.textContent || "") || null,
      unjustified: clean(totalCells[1]?.textContent || "") || null,
      delays: clean(totalCells[2]?.textContent || "") || null
    };
  }

  function absenceDurationMinutes(value = "") {
    const times = [...clean(value).matchAll(/(\d{1,2})\s*[h:]\s*(\d{2})/gi)].map(match => Number(match[1]) * 60 + Number(match[2]));
    if (times.length >= 2) {
      const difference = times[1] - times[0];
      return difference >= 0 ? difference : difference + 24 * 60;
    }
    if (times.length === 1 && !/[-–—à]/i.test(value)) return times[0];
    const decimalHours = clean(value).replace(",", ".").match(/^(\d+(?:\.\d+)?)\s*h(?:eures?)?$/i);
    return decimalHours ? Math.round(Number(decimalHours[1]) * 60) : null;
  }

  function formatDuration(minutes, fallback = "") {
    if (!Number.isFinite(minutes)) return normalizeDurationLabel(fallback);
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours} h ${String(remainder).padStart(2, "0")}`;
  }

  function normalizeDurationLabel(value = "") {
    const label = clean(String(value ?? ""));
    if (!label) return "—";
    const match = label.match(/^(\d+)\s*h(?:\s*(\d{1,2}))?$/i);
    return match ? `${Number(match[1])} h ${String(Number(match[2] || 0)).padStart(2, "0")}` : label;
  }

  function absenceSummary(rows, fallback = {}) {
    const total = status => rows.filter(row => status(row.status)).reduce((sum, row) => sum + (Number.isFinite(row.durationMinutes) ? row.durationMinutes : 0), 0);
    const justified = total(status => status === "Justifiée");
    const unjustified = total(status => status === "Non justifiée");
    const delays = rows.filter(row => row.status === "Retard").length;
    return {
      justified: justified || rows.some(row => row.status === "Justifiée") ? formatDuration(justified) : normalizeDurationLabel(fallback.justified),
      unjustified: unjustified || rows.some(row => row.status === "Non justifiée") ? formatDuration(unjustified) : normalizeDurationLabel(fallback.unjustified),
      delays: delays || rows.some(row => row.status === "Retard") ? String(delays) : fallback.delays
    };
  }

  async function readCurrentSemester(label, index) {
    const host = document.querySelector("releve-but");
    const root = host?.shadowRoot;
    if (!root) return null;
    return parseSemester(root, label, index);
  }

  async function collectAll() {
    const semesterInputs = [...document.querySelectorAll('input[name="semestre"]')];
    const labels = semesterInputs.map(input => input.closest("label"));
    const current = semesterInputs.findIndex(input => input.checked);
    const semesters = [];
    let failedSemesters = 0;
    const absenceRows = new Map();
    let absenceTotals = { justified: null, unjustified: null, delays: null };
    for (let i = 0; i < labels.length; i++) {
      const expected = clean(labels[i]?.innerText || "").match(/Semestre\s+\d+/i)?.[0] || "";
      labels[i]?.querySelector("[data-semestre]")?.click();
      const loaded = await waitFor(() => {
        const root = document.querySelector("releve-but")?.shadowRoot;
        const heading = clean(root?.querySelector(".enteteSemestre h2, .enteteSemestre, h2")?.textContent || "");
        return root?.querySelector(".ready, .releve") && (!expected || heading.includes(expected));
      }, 8000);
      if (!loaded) {
        failedSemesters++;
        continue;
      }
      await delay(350);
      const label = clean(labels[i]?.innerText || `Semestre ${i + 1}`);
      const semester = await readCurrentSemester(label, i);
      if (semester) semesters.push(semester);
      const absences = parseAbsences();
      absences.rows.forEach(row => absenceRows.set(`${row.date}|${row.timeRange || row.hours}|${row.subject}|${row.teacher}|${row.status}`, row));
      if (i === 0) absenceTotals = absences;
    }
    if (current >= 0) {
      labels[current]?.querySelector("[data-semestre]")?.click();
      const expected = clean(labels[current]?.innerText || "").match(/Semestre\s+\d+/i)?.[0] || "";
      await waitFor(() => {
        const root = document.querySelector("releve-but")?.shadowRoot;
        const heading = clean(root?.querySelector(".enteteSemestre h2, .enteteSemestre, h2")?.textContent || "");
        return !expected || heading.includes(expected);
      }, 8000);
    }
    const root = document.querySelector("releve-but")?.shadowRoot;
    return {
      updatedAt: new Date().toISOString(),
      schemaVersion: CACHE_SCHEMA,
      complete: failedSemesters === 0 && semesters.length === labels.length,
      student: parseStudent(root),
      semesters,
      absences: { ...absenceSummary([...absenceRows.values()], absenceTotals), rows: [...absenceRows.values()] }
    };
  }

  function comparable(snapshot) {
    if (!snapshot) return "";
    const copy = JSON.parse(JSON.stringify(snapshot));
    delete copy.updatedAt;
    delete copy.changes;
    delete copy.complete;
    delete copy.schemaVersion;
    return JSON.stringify(copy);
  }

  function evaluationMap(snapshot) {
    const map = new Map();
    for (const semester of snapshot?.semesters || []) {
      for (const module of [...semester.resources, ...semester.saes]) {
        module.evaluations.forEach(item => map.set(`${semester.label}|${module.code}|${item.title}`, item.grade));
      }
    }
    return map;
  }

  function summarizeChanges(previous, next) {
    if (!previous) return ["Premier enregistrement local"];
    const changes = [];
    const before = evaluationMap(previous);
    const after = evaluationMap(next);
    let newGrades = 0;
    let changedGrades = 0;
    after.forEach((grade, key) => {
      if (!before.has(key) && grade !== null) newGrades++;
      else if (before.has(key) && before.get(key) !== grade) changedGrades++;
    });
    if (newGrades) changes.push(`${newGrades} nouvelle${newGrades > 1 ? "s" : ""} note${newGrades > 1 ? "s" : ""}`);
    if (changedGrades) changes.push(`${changedGrades} note${changedGrades > 1 ? "s" : ""} modifiée${changedGrades > 1 ? "s" : ""}`);
    const beforeAverages = new Map((previous.semesters || []).map(s => [s.label, s.average]));
    const changedAverages = (next.semesters || []).filter(s => beforeAverages.has(s.label) && beforeAverages.get(s.label) !== s.average).length;
    if (changedAverages) changes.push(`${changedAverages} moyenne${changedAverages > 1 ? "s" : ""} mise${changedAverages > 1 ? "s" : ""} à jour`);
    const absenceDelta = (next.absences?.rows?.length || 0) - (previous.absences?.rows?.length || 0);
    if (absenceDelta > 0) changes.push(`${absenceDelta} nouvelle${absenceDelta > 1 ? "s" : ""} absence${absenceDelta > 1 ? "s" : ""}`);
    return changes.length ? changes : ["Structure Narval mise à jour"];
  }

  async function acceptFreshSnapshot(fresh, previous = model) {
    const checkedAt = new Date().toISOString();
    if (!fresh.complete && previous) {
      model = previous;
      syncStatus = { state: "error", message: "Vérification incomplète · données locales conservées" };
      await chrome.storage.local.set({ lastCheckedAt: checkedAt });
      return false;
    }
    if (previous && comparable(previous) === comparable(fresh)) {
      model = previous;
      syncStatus = { state: "current", message: "Aucun changement détecté" };
      await chrome.storage.local.set({ lastCheckedAt: checkedAt });
      return false;
    }
    fresh.updatedAt = checkedAt;
    fresh.changes = summarizeChanges(previous, fresh);
    model = fresh;
    syncStatus = { state: "changed", message: fresh.changes.join(" · ") };
    await chrome.storage.local.set({ lastSnapshot: fresh, lastCheckedAt: checkedAt });
    return true;
  }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(test, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = test();
      if (result) return result;
      await delay(100);
    }
    return null;
  }

  function gradeTone(grade) {
    if (grade === null) return "muted";
    if (grade >= 14) return "great";
    if (grade >= 10) return "good";
    return "warn";
  }

  function renderSidebar() {
    return `<aside class="nn-sidebar">
      <button class="nn-menu-close" data-action="close-menu" aria-label="Fermer le menu">×</button>
      <div class="nn-brand">${model.student.photo ? `<img src="${escapeHtml(model.student.photo)}" alt="">` : `<span class="nn-brand-mark">${escapeHtml(model.student.name.charAt(0))}</span>`}<div><strong>${escapeHtml(model.student.fullLabel)}</strong><small>${escapeHtml(model.student.program)}</small></div></div>
      <div class="nn-nav-label">Espace étudiant</div>
      <div class="nn-nav-list" role="navigation" aria-label="Navigation principale">
        ${navButton("dashboard", "Tableau de bord", icon("home"))}
        ${navButton("semesters", "Résultats", icon("results"))}
        ${navButton("ranking", "Classement", icon("ranking"))}
        ${navButton("absences", "Absences", icon("calendar"))}
      </div>
      <button class="nn-original-link" data-action="original">${icon("external")}Interface Narval originale</button>
    </aside>`;
  }

  function navButton(view, label, icon) {
    return `<button data-view="${view}" class="nn-nav ${activeView === view ? "active" : ""}"><span class="nn-nav-icon">${icon}</span>${label}</button>`;
  }

  function icon(name) {
    const paths = {
      home: '<path d="M3 10.8 12 3l9 7.8v8.7a1.5 1.5 0 0 1-1.5 1.5h-5v-6h-5v6h-5A1.5 1.5 0 0 1 3 19.5z"/>',
      results: '<path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1 2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 15l3-3 2.5 2.5L17 9"/>',
      ranking: '<path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18"/>',
      external: '<path d="M14 4h6v6m0-6-9 9"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
  }

  function renderHeader(title) {
    const updatedLabel = model.updatedAt ? `Mis à jour le ${new Date(model.updatedAt).toLocaleString("fr-FR", {day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}` : "Données Narval";
    const statusLabel = syncStatus.state === "checking" || syncStatus.state === "error" ? syncStatus.message : updatedLabel;
    return `<header class="nn-header">
      <button class="nn-mobile-menu" aria-label="Ouvrir le menu">☰</button>
      <div class="nn-header-heading"><h1>${escapeHtml(title)}</h1></div>
      <div class="nn-header-actions">
        <div class="nn-sync ${escapeHtml(syncStatus.state)}" title="${escapeHtml(syncStatus.message)}"><i></i><strong>${escapeHtml(statusLabel)}</strong></div>
        <button class="nn-icon-button" data-action="refresh" title="Vérifier les changements">↻</button>
      </div>
    </header>${renderUpdateNotice()}`;
  }

  function versionParts(value) {
    return String(value || "").trim().replace(/^v/i, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  }

  function isNewerVersion(candidate, current) {
    const next = versionParts(candidate);
    const installed = versionParts(current);
    const length = Math.max(next.length, installed.length, 3);
    for (let index = 0; index < length; index += 1) {
      if ((next[index] || 0) !== (installed[index] || 0)) return (next[index] || 0) > (installed[index] || 0);
    }
    return false;
  }

  function renderUpdateNotice() {
    if (!updateState.available || Date.now() < updateState.snoozedUntil) return "";
    const shouldAnimate = animatedUpdateVersion !== updateState.version;
    animatedUpdateVersion = updateState.version;
    return `<aside class="nn-update-notice${shouldAnimate ? " is-entering" : ""}" role="status" aria-live="polite" aria-label="Mise à jour de Narval+">
      <div class="nn-update-copy"><span class="nn-update-icon" aria-hidden="true">&#8593;</span><div><strong>${escapeHtml(updateState.title || `Narval+ ${updateState.version} est disponible`)}</strong><p>${escapeHtml(updateState.message || "Téléchargez la nouvelle version depuis GitHub, remplacez les fichiers du dossier puis rechargez l’extension dans Chrome.")}</p></div></div>
      <div class="nn-update-actions">${updateState.mandatory ? "" : `<button class="nn-update-later" data-action="snooze-update">Plus tard</button>`}<button class="nn-update-open" data-action="open-update">Télécharger la mise à jour</button></div>
    </aside>`;
  }

  async function checkForExtensionUpdate(settings = {}) {
    if (!UPDATE_CONFIG.versionUrl) return;
    const installedVersion = chrome.runtime.getManifest().version;
    const cached = settings.extensionUpdateCache;
    const snoozedVersion = settings.extensionUpdateSnoozedVersion || "";
    const snoozedUntil = Number(settings.extensionUpdateSnoozedUntil) || 0;
    const applyVersion = appVersion => {
      const version = String(appVersion?.version || "").replace(/^v/i, "");
      updateState = {
        available: isNewerVersion(version, installedVersion),
        version,
        title: String(appVersion?.title || ""),
        message: String(appVersion?.message || ""),
        url: appVersion?.downloadUrl || UPDATE_CONFIG.downloadUrl,
        mandatory: appVersion?.mandatory === true,
        snoozedUntil: appVersion?.mandatory === true ? 0 : version === snoozedVersion ? snoozedUntil : 0
      };
    };
    if (cached) applyVersion(cached);
    if (model) render();
    try {
      const response = await fetch(UPDATE_CONFIG.versionUrl, {cache:"no-store"});
      if (!response.ok) return;
      const payload = await response.json();
      const appVersion = payload?.appVersion;
      const nextCache = {
        version: String(appVersion?.version || "").replace(/^v/i, ""),
        title: String(appVersion?.title || ""),
        message: String(appVersion?.message || ""),
        downloadUrl: appVersion?.downloadUrl || UPDATE_CONFIG.downloadUrl,
        mandatory: appVersion?.mandatory === true,
        checkedAt: Date.now()
      };
      await chrome.storage.local.set({ extensionUpdateCache:nextCache });
      applyVersion(nextCache);
      if (model) render();
    } catch (error) {
      console.debug("Narval+ : vérification de mise à jour indisponible", error);
    }
  }

  function semesterSelect() {
    const groups = new Map();
    model.semesters.forEach((semester, index) => {
      const year = semester.label.match(/\d{4}\s*\/\s*\d{4}/)?.[0]?.replace(/\s/g, "") || "Autres semestres";
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push({ semester, index });
    });
    const options = [...groups.entries()].map(([year, entries]) => `<optgroup label="Année ${escapeHtml(year)}"><option value="year:${escapeHtml(year)}" ${selectedPeriod===`year:${year}`?"selected":""}>Vue annuelle · ${escapeHtml(year)}</option>${entries.map(({semester,index})=>`<option value="semester:${index}" ${selectedPeriod===`semester:${index}`?"selected":""}>${escapeHtml(semester.label.replace(/.*?(Semestre\s+\d+.*)$/i,"$1"))}</option>`).join("")}</optgroup>`).join("");
    return `<label class="nn-semester-select"><span>Année et semestre</span><select data-semester-select>${options}</select></label>`;
  }

  function selectedPeriodData() {
    let semesters = [];
    let type = "semester";
    let label = "";
    if (selectedPeriod.startsWith("year:")) {
      type = "year";
      const year = selectedPeriod.slice(5);
      semesters = model.semesters.filter(item => item.label.replace(/\s/g, "").includes(year));
      label = `Année ${year}`;
    } else {
      const index = Number(selectedPeriod.split(":")[1] || 0);
      semesters = [model.semesters[index] || model.semesters[0]].filter(Boolean);
      label = semesters[0]?.title || "Semestre";
    }
    const calculable = semesters.filter(item => (item.calculatedAverage ?? item.average) !== null);
    const semesterAverages = calculable.map(item => Number((item.calculatedAverage ?? item.average).toFixed(2)));
    const average = semesterAverages.length
      ? Math.round(semesterAverages.reduce((sum, value) => sum + Math.round(value * 100), 0) / semesterAverages.length) / 100
      : null;
    const ects = semesters.reduce((acc, item) => ({earned:acc.earned+(item.ects?.earned||0),total:acc.total+(item.ects?.total||0)}), {earned:0,total:0});
    const rawCompetencies = semesters.flatMap(item => item.competencies
      .filter(comp => !/^bonus$/i.test(clean(comp.code)) && !/^bonus$/i.test(clean(comp.title)))
      .map(comp => ({...comp, semester:item.label.match(/Semestre\s+\d+/i)?.[0] || item.title})));
    const competencies = type === "year" ? groupAnnualCompetencies(rawCompetencies) : rawCompetencies;
    const modules = semesters.flatMap(item => [...item.resources, ...item.saes].map(module => ({
      ...module,
      semester: item.label.match(/Semestre\s+\d+/i)?.[0] || item.title,
      academicYear: academicYear(item)
    })));
    const evaluations = modules.flatMap(module => module.evaluations.map(evaluation => ({...evaluation,module:module.code})));
    return { type, label, semesters, average, ects, competencies, modules, evaluations, semesterAverages };
  }

  function normalizedTitle(value = "") {
    return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function slug(value = "") {
    return normalizedTitle(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
  }

  function academicYear(semester) {
    return semester.label?.match(/\d{4}\s*\/\s*\d{4}/)?.[0]?.replace(/\s/g, "") || "inconnue";
  }

  function cohortKey() {
    const track = model.semesters.some(item => /\bVCOD\b/i.test(item.title)) ? "vcod" : "tronc-commun";
    return slug(`${model.student.program}-${track}`);
  }

  function periodKey(period = selectedPeriodData()) {
    if (period.type === "year") return `year-${slug(period.label.replace(/^Année\s+/i,""))}`;
    const semester = period.semesters[0];
    const number = semester?.label.match(/Semestre\s*(\d+)/i)?.[1] || semester?.title.match(/Semestre\s*(\d+)/i)?.[1] || "x";
    return `semester-${number}-${slug(academicYear(semester || {}))}`;
  }

  function contributionEntries() {
    const cohort = cohortKey();
    const entries = [];
    for (const semester of model.semesters) {
      const average = semester.calculatedAverage ?? semester.average;
      const number = semester.label.match(/Semestre\s*(\d+)/i)?.[1] || semester.title.match(/Semestre\s*(\d+)/i)?.[1] || "x";
      const key = `semester-${number}-${slug(academicYear(semester))}`;
      if (average !== null) entries.push({cohortKey:cohort,periodKey:key,metricKey:"overall",score:average});
      semester.competencies.filter(item => !/^bonus$/i.test(clean(item.code)) && !/^bonus$/i.test(clean(item.title))).forEach(item => {
        const score = item.average ?? item.calculatedAverage;
        if (score !== null) entries.push({cohortKey:cohort,periodKey:key,metricKey:`competency-${slug(item.title || item.code)}`,score});
      });
      [...semester.resources,...semester.saes].forEach(module=>{
        const score=module.calculatedAverage??module.officialAverage;
        if(score!==null)entries.push({cohortKey:"shared-modules",periodKey:`year-${slug(academicYear(semester))}`,metricKey:`module-${module.kind}-${slug(module.title)}`,score});
      });
    }
    for (const year of [...new Set(model.semesters.map(academicYear))]) {
      const semesters = model.semesters.filter(item => academicYear(item) === year);
      const values = semesters.map(item => item.calculatedAverage ?? item.average).filter(value => value !== null);
      const key = `year-${slug(year)}`;
      if (values.length) entries.push({cohortKey:cohort,periodKey:key,metricKey:"overall",score:Math.round(values.reduce((sum,value)=>sum+Math.round(value*100),0)/values.length)/100});
      const competencies = groupAnnualCompetencies(semesters.flatMap(item => item.competencies.filter(comp => !/^bonus$/i.test(clean(comp.code)) && !/^bonus$/i.test(clean(comp.title))).map(comp => ({...comp,semester:item.label}))));
      competencies.forEach(item => { const score=item.average ?? item.calculatedAverage; if(score!==null) entries.push({cohortKey:cohort,periodKey:key,metricKey:`competency-${slug(item.title || item.code)}`,score}); });
    }
    return entries.slice(0,250);
  }

  function randomHex(bytes = 32) {
    const value = new Uint8Array(bytes);
    crypto.getRandomValues(value);
    return [...value].map(byte => byte.toString(16).padStart(2,"0")).join("");
  }

  function deviceLabel() {
    const platform = navigator.userAgentData?.platform || navigator.platform || "Appareil";
    const browser = /Edg\//.test(navigator.userAgent) ? "Edge" : /Chrome\//.test(navigator.userAgent) ? "Chrome" : "Navigateur";
    return `${browser} · ${platform}`.slice(0,60);
  }

  function ensureLocalDevicePreview() {
    if (!rankingSettings.deviceId || deviceState.devices.length) return;
    deviceState = {
      devices:[{deviceIdHash:"local-current-device",label:deviceLabel(),lastSeenAt:new Date().toISOString(),revokedAt:null,isCurrent:true}],
      currentDeviceIdHash:"local-current-device",
      message:""
    };
  }

  async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
  }

  function authPayload() {
    return {ownerId:rankingSettings.contributorId,deviceId:rankingSettings.deviceId,deviceToken:rankingSettings.deviceToken};
  }

  async function ensureRankingIdentity(registrationGrant = "") {
    let changed=false;
    if(!rankingSettings.contributorId){rankingSettings.contributorId=crypto.randomUUID();changed=true;}
    if(!rankingSettings.deviceId){rankingSettings.deviceId=crypto.randomUUID();changed=true;}
    if(!rankingSettings.deviceToken){rankingSettings.deviceToken=randomHex(32);changed=true;}
    if(changed)await chrome.storage.local.set({rankingContributorId:rankingSettings.contributorId,rankingDeviceId:rankingSettings.deviceId,rankingDeviceToken:rankingSettings.deviceToken});
    ensureLocalDevicePreview();
    await rankingRequest("/api/identity/register",{method:"POST",body:JSON.stringify({...authPayload(),registrationProof:await sha256(`narval-register-v1:${rankingSettings.contributorId}`),registrationGrant,label:deviceLabel()})});
  }

  function bytesToBase64Url(bytes) {
    let binary="";bytes.forEach(byte=>binary+=String.fromCharCode(byte));
    return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  }

  function base64UrlToBytes(value) {
    const base64=value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4);
    return Uint8Array.from(atob(base64),character=>character.charCodeAt(0));
  }

  async function pairingKey(secret) {
    return crypto.subtle.importKey("raw",await crypto.subtle.digest("SHA-256",new TextEncoder().encode(secret)),{name:"AES-GCM"},false,["encrypt","decrypt"]);
  }

  async function createDevicePairing() {
    try {
      await ensureRankingIdentity();
      const pairingId=randomHex(16), secret=randomHex(32), iv=crypto.getRandomValues(new Uint8Array(12));
      const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},await pairingKey(secret),new TextEncoder().encode(JSON.stringify({version:1,contributorId:rankingSettings.contributorId})));
      const result=await rankingRequest("/api/pairings",{method:"POST",body:JSON.stringify({...authPayload(),pairingId,ciphertext:bytesToBase64Url(new Uint8Array(encrypted)),iv:bytesToBase64Url(iv)})});
      pairingState={code:`narval-pair.${pairingId}.${secret}.${rankingSettings.deviceId}`,expiresAt:result.expiresAt,message:"Code créé · valable 5 minutes et utilisable une seule fois"};
      await loadDevices();
      pollPairingDevices(result.expiresAt);
    }catch(error){pairingState={code:"",expiresAt:"",message:error.message};}
    render();
  }

  async function joinDevicePairing(code) {
    try {
      const match=clean(code).match(/^narval-pair\.([a-f0-9]{32})\.([a-f0-9]{64})\.([a-f0-9-]{20,100})$/i);
      if(!match)throw new Error("Code d’appairage invalide");
      if(rankingSettings.deviceId&&match[3]===rankingSettings.deviceId)throw new Error("Cet appareil est déjà associé");
      if(rankingSettings.contributorId&&rankingSettings.deviceId)throw new Error("Cet appareil possède déjà une identité. Supprimez-la avant de l’associer à une autre.");
      pairingState={code:"",expiresAt:"",message:"Association en cours…"};render();
      const result=await rankingRequest("/api/pairings/consume",{method:"POST",body:JSON.stringify({pairingId:match[1]})});
      const decrypted=await crypto.subtle.decrypt({name:"AES-GCM",iv:base64UrlToBytes(result.iv)},await pairingKey(match[2]),base64UrlToBytes(result.ciphertext));
      const identity=JSON.parse(new TextDecoder().decode(decrypted));
      if(identity.version!==1||!/^[a-f0-9-]{20,100}$/i.test(identity.contributorId||""))throw new Error("Identité d’appairage invalide");
      rankingSettings={enabled:true,contributorId:identity.contributorId,deviceId:crypto.randomUUID(),deviceToken:randomHex(32)};
      await chrome.storage.local.set({rankingEnabled:true,rankingContributorId:rankingSettings.contributorId,rankingDeviceId:rankingSettings.deviceId,rankingDeviceToken:rankingSettings.deviceToken});
      await ensureRankingIdentity(result.registrationGrant);
      pairingState={code:"",expiresAt:"",message:"Appareil associé avec succès"};
      await contributeRanking();
      await loadDevices();
    }catch(error){pairingState={code:"",expiresAt:"",message:error.message};render();}
  }

  async function loadDevices() {
    if(!rankingSettings.contributorId||!rankingSettings.deviceId||!rankingSettings.deviceToken)return;
    try {
      const result=await rankingRequest("/api/devices/list",{method:"POST",body:JSON.stringify(authPayload())});
      deviceState={devices:result.devices||[],currentDeviceIdHash:result.currentDeviceIdHash,message:""};
      await chrome.storage.local.set({rankingDevicesCache:deviceState});
    }catch(error){deviceState={...deviceState,message:error.message};}
  }

  function pollPairingDevices(expiresAt) {
    clearTimeout(pairingPoll);
    const poll=async()=>{
      if(Date.now()>=Date.parse(expiresAt)||!rankingSettings.deviceId)return;
      const before=deviceState.devices.map(item=>`${item.deviceIdHash}:${item.revokedAt||""}`).join("|");
      await loadDevices();
      const after=deviceState.devices.map(item=>`${item.deviceIdHash}:${item.revokedAt||""}`).join("|");
      if(before!==after)render();
      pairingPoll=setTimeout(poll,3000);
    };
    pairingPoll=setTimeout(poll,3000);
  }

  async function revokeDevice(targetDeviceIdHash) {
    try {
      await rankingRequest("/api/devices/revoke",{method:"POST",body:JSON.stringify({...authPayload(),targetDeviceIdHash})});
      await loadDevices();
      deviceState.message="Appareil révoqué";
    }catch(error){deviceState.message=error.message;}
    render();
  }

  async function rankingRequest(path, options = {}) {
    if (!RANK_CONFIG.apiUrl) throw new Error("Serveur non configuré");
    const response = await fetch(`${RANK_CONFIG.apiUrl.replace(/\/$/,"")}${path}`, {cache:"no-store",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
    if (!response.ok) throw new Error(`Serveur indisponible (${response.status})`);
    return response.json();
  }

  async function loadRanking() {
    if (!rankingSettings.enabled || !model) return;
    const period = selectedPeriodData();
    const key = periodKey(period);
    const cohort = cohortKey();
    const cached = rankingCache[key];
    if (cached) rankingState = cached;
    else rankingState = {state:"loading",periodKey:key,overall:null,competencies:{},modules:{},message:"Chargement du classement…"};
    if (periodKey() === key) render();
    try {
      const queries=[];
      if(period.average!==null)queries.push({id:"overall",cohortKey:cohort,periodKey:key,metricKey:"overall",score:period.average});
      period.competencies.forEach(item=>{const score=item.calculatedAverage??item.average,metricKey=`competency-${slug(item.title||item.code)}`;if(score!==null)queries.push({id:`competency:${metricKey}`,cohortKey:cohort,periodKey:key,metricKey,score});});
      period.modules.forEach(module=>{const score=module.calculatedAverage??module.officialAverage,metricKey=moduleMetricKey(module);if(score!==null)queries.push({id:`module:${metricKey}:${module.academicYear}`,cohortKey:"shared-modules",periodKey:`year-${slug(module.academicYear)}`,metricKey,score});});
      const response=await rankingRequest("/api/ranks",{method:"POST",body:JSON.stringify({queries})});
      const results=new Map((response.results||[]).map(item=>[item.id,item.result]));
      const competencies={},modules={};
      period.competencies.forEach(item=>{const metric=`competency-${slug(item.title||item.code)}`,result=results.get(`competency:${metric}`);if(result)competencies[metric]=result;});
      period.modules.forEach(module=>{const id=`${moduleMetricKey(module)}:${module.academicYear}`,result=results.get(`module:${id}`);if(result)modules[id]=result;});
      const nextState = {state:"ready",periodKey:key,overall:results.get("overall")||null,competencies,modules,message:"Classement à jour",updatedAt:new Date().toISOString()};
      rankingCache[key] = nextState;
      await chrome.storage.local.set({rankingCache});
      if (periodKey() === key) rankingState = nextState;
    } catch (error) {
      if (!cached && periodKey() === key) rankingState = {state:"error",periodKey:key,overall:null,competencies:{},modules:{},message:error.message};
    }
    if (periodKey() === key) render();
  }

  function moduleMetricKey(module) { return `module-${module.kind}-${slug(module.title)}`; }

  function moduleRank(module) { return rankingState.modules?.[`${moduleMetricKey(module)}:${module.academicYear}`] || null; }

  async function contributeRanking() {
    rankingState = {...rankingState,state:"loading",message:"Envoi de votre contribution anonyme…"}; render();
    try {
      await ensureRankingIdentity();
      await rankingRequest("/api/contributions",{method:"POST",body:JSON.stringify({...authPayload(),entries:contributionEntries()})});
      await chrome.storage.local.set({rankingLastContribution:new Date().toISOString()});
      await Promise.all([loadRanking(),loadDevices()]);
    } catch(error) { rankingState={...rankingState,state:"error",message:error.message}; render(); }
  }

  async function toggleRanking() {
    try {
      rankingSettings.enabled=!rankingSettings.enabled;
      if(rankingSettings.enabled)await ensureRankingIdentity();
      await chrome.storage.local.set({rankingEnabled:rankingSettings.enabled,rankingContributorId:rankingSettings.contributorId,rankingDeviceId:rankingSettings.deviceId,rankingDeviceToken:rankingSettings.deviceToken});
      if(rankingSettings.enabled)await contributeRanking();
      else{rankingState={state:"disabled",periodKey:"",overall:null,competencies:{},message:"Participation désactivée"};render();}
    }catch(error){rankingSettings.enabled=false;await chrome.storage.local.set({rankingEnabled:false});rankingState={...rankingState,state:"error",message:error.message};render();}
  }

  async function deleteRankingContribution() {
    try {
      await rankingRequest("/api/contributions",{method:"DELETE",body:JSON.stringify(authPayload())});
      rankingSettings={enabled:false,contributorId:"",deviceId:"",deviceToken:""};
      deviceState={devices:[],currentDeviceIdHash:"",message:"Identité et appareils supprimés"};
      pairingState={code:"",expiresAt:"",message:""};
      clearTimeout(pairingPoll);
      rankingCache={};
      await chrome.storage.local.remove(["rankingContributorId","rankingDeviceId","rankingDeviceToken","rankingDevicesCache","rankingLastContribution","rankingCache"]);
      await chrome.storage.local.set({rankingEnabled:false});
      rankingState={state:"disabled",periodKey:"",overall:null,competencies:{},modules:{},message:"Contribution et appareils supprimés"};
    } catch(error) {
      rankingState={...rankingState,state:"error",message:`Suppression impossible : ${error.message}`};
    }
    render();
  }

  function rankLabel(result) {
    if (!result) return "—";
    if (!result.available) return `${result.participantCount}/${result.minimumParticipants}`;
    return `${result.position}${result.position===1?"er":"e"}/${result.participantCount}`;
  }

  function rankDetail(result) {
    if (!result) return rankingState.message || "Aucune donnée";
    if (!result.available) return `Encore ${Math.max(0,result.minimumParticipants-result.participantCount)} contribution(s) nécessaire(s)`;
    return `${result.tied>1?`${result.tied} ex æquo · `:""}meilleur que ${result.percentile}% du groupe`;
  }

  function groupAnnualCompetencies(competencies) {
    const groups = new Map();
    competencies.forEach(item => {
      const key = normalizedTitle(item.title || item.code);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return [...groups.values()].map(items => {
      const values = items.map(item => item.average ?? item.calculatedAverage).filter(value => value !== null);
      const average = values.length
        ? Math.round(values.reduce((sum, value) => sum + Math.round(value * 100), 0) / values.length) / 100
        : null;
      return {
        ...items[0],
        average,
        calculatedAverage: average,
        semester: items.map(item => item.semester).join(" + "),
        annualParts: items.map(item => ({semester:item.semester,value:item.average ?? item.calculatedAverage}))
      };
    });
  }

  function metric(label, value, detail, tone = "blue") {
    return `<article class="nn-metric ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`;
  }

  function renderDashboard() {
    const period = selectedPeriodData();
    if (!period.semesters.length) return emptyState("Aucun semestre lisible", "Rechargez Narval lorsque votre relevé est disponible.");
    const evals = period.evaluations;
    const graded = evals.filter(e => e.grade !== null).slice(-6).reverse();
    const semester = period.semesters[0];
    const currentRank = rankingState.periodKey === periodKey(period) ? rankingState.overall : null;
    return `${renderHeader("Tableau de bord")}
      <main class="nn-content">
        <section class="nn-period-toolbar">${semesterSelect()}</section>
        <section class="nn-metrics">
          ${metric(period.type === "year" ? "Moyenne annuelle" : "Moyenne du semestre", display(period.average, "/20"), period.average === null ? "Aucune évaluation publiée" : period.type === "year" ? `Moyenne des ${calculableSemesterLabel(period.semesters)}` : semester.label.match(/Semestre\s+\d+/i)?.[0] || semester.title, "indigo")}
          ${metric("Rang communautaire", rankingSettings.enabled ? rankLabel(currentRank) : "Inactif", rankingSettings.enabled ? rankDetail(currentRank) : "Participation volontaire", "green")}
          ${metric("Compétences", String(period.competencies.length), period.type === "year" ? "Cumulées sur l’année" : "Unités suivies", "amber")}
          ${metric("Évaluations", String(evals.length), `${graded.length} notes récentes`, "rose")}
        </section>
        <div class="nn-grid nn-grid-main">
          <section class="nn-card"><div class="nn-card-head"><div><span class="nn-eyebrow">Progression</span><h3>Compétences</h3></div></div>
            <div class="nn-competency-list">${period.competencies.map(renderCompetency).join("") || emptyInline("Aucune compétence publiée")}</div>
          </section>
          <section class="nn-card"><div class="nn-card-head"><div><span class="nn-eyebrow">Dernières données</span><h3>Évaluations</h3></div><button class="nn-link" data-view="semesters">Tout voir</button></div>
            <div class="nn-eval-list">${graded.map(renderEvaluationRow).join("") || emptyInline("Aucune note publiée")}</div>
          </section>
        </div>
      </main>`;
  }

  function renderCompetency(item) {
    const average = item.calculatedAverage ?? item.average;
    const percent = average === null ? 0 : Math.min(100, average * 5);
    return `<div class="nn-competency"><div class="nn-ring" style="--p:${percent}"><span>${display(average)}</span></div><div><strong>${escapeHtml(item.title || item.code)}</strong><div class="nn-progress"><i style="width:${percent}%"></i></div></div></div>`;
  }

  function calculableSemesterLabel(semesters) {
    const labels = semesters.filter(item => (item.calculatedAverage ?? item.average) !== null).map(item => item.label.match(/Semestre\s+\d+/i)?.[0] || item.title);
    if (!labels.length) return "semestres disponibles";
    if (labels.length === 1) return labels[0];
    return `${labels.slice(0, -1).join(", ")} et ${labels.at(-1)}`;
  }

  function renderEvaluationRow(item) {
    return `<div class="nn-eval"><span class="nn-grade ${gradeTone(item.grade)}">${display(item.grade)}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.module || "")}${item.coefficient !== null ? ` · coef. ${item.coefficient}` : ""}</small></div></div>`;
  }

  function renderSemesters() {
    const period = selectedPeriodData();
    const semester = period.semesters[0];
    const moduleGroups = period.semesters.map(item => ({
      label:item.title,
      modules:[...item.resources, ...item.saes].map(module => ({...module, semester:item.label.match(/Semestre\s+\d+/i)?.[0] || item.title,academicYear:academicYear(item)}))
    }));
    return `${renderHeader("Résultats")}
      <main class="nn-content">
        <section class="nn-period-toolbar">${semesterSelect()}</section>
        ${semester ? `<section class="nn-summary-strip"><div><span>${period.type === "year" ? "Moyenne annuelle" : "Moyenne du semestre"}</span><strong>${display(period.average,"/20")}</strong></div><div><span>${period.type === "year" ? "Semestres" : "Rang Narval"}</span><strong>${period.type === "year" ? period.semesters.length : semester.rank?`${semester.rank.position}/${semester.rank.total}`:"—"}</strong></div><div><span>Enseignements</span><strong>${period.modules.length}</strong></div><div><span>Évaluations</span><strong>${period.evaluations.length}</strong></div></section>
        ${period.type === "year" ? `<section class="nn-annual-semesters">${period.semesters.map((item,index)=>`<article><span>${escapeHtml(item.label.match(/Semestre\s+\d+/i)?.[0] || item.title)}</span><strong>${display(period.semesterAverages[index], "/20")}</strong><small>${[...item.resources,...item.saes].length} enseignements · ${[...item.resources,...item.saes].reduce((sum,module)=>sum+module.evaluations.length,0)} évaluations</small></article>`).join("")}</section>` : ""}
        <section class="nn-card"><div class="nn-card-head"><div><span class="nn-eyebrow">${escapeHtml(period.label)}</span><h3>Ressources et SAÉ</h3></div><input class="nn-search" placeholder="Rechercher une matière…" aria-label="Rechercher"></div>
          ${moduleGroups.map(group=>`<div class="nn-year-group"><h4>${escapeHtml(group.label)}</h4><div class="nn-module-list">${group.modules.map(renderModule).join("") || emptyInline("Aucune évaluation publiée")}</div></div>`).join("")}
        </section>` : emptyState("Aucun semestre", "Les données ne sont pas encore disponibles.")}
      </main>`;
  }

  function renderModule(module) {
    const average = module.calculatedAverage ?? calculateAverage(module.evaluations);
    const community=rankingSettings.enabled?moduleRank(module):null;
    const context = module.semester ? `${module.semester} · ${module.kind === "sae" ? "SAÉ" : "Ressource"} · ` : "";
    return `<details class="nn-module" data-search="${escapeHtml(`${module.code} ${module.title} ${module.semester || ""}`.toLowerCase())}"><summary><span class="nn-module-icon ${module.kind}">${module.kind === "sae" ? "S" : "R"}</span><div><strong>${escapeHtml(module.title)}</strong><small>${escapeHtml(context + module.code)} · ${module.evaluations.length} évaluation${module.evaluations.length>1?"s":""}</small></div><span class="nn-module-average ${gradeTone(average)}" title="Moyenne">${display(average)}${community?`<small>${escapeHtml(rankLabel(community))}</small>`:""}</span><span class="nn-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></span></summary><div class="nn-module-body">${module.evaluations.map(e=>renderEvaluationRow({...e,module:module.code})).join("") || emptyInline("Aucune note publiée")}</div></details>`;
  }

  function renderRanking() {
    const period = selectedPeriodData();
    const result = rankingState.periodKey === periodKey(period) ? rankingState.overall : null;
    return `${renderHeader("Classement")}
      <main class="nn-content">
        <section class="nn-results-toolbar nn-ranking-toolbar">${semesterSelect()}</section>
        ${rankingSettings.enabled ? "" : `<section class="nn-ranking-info nn-ranking-settings"><strong>Participation volontaire</strong><div class="nn-ranking-actions"><button class="nn-primary-action" data-action="toggle-ranking">Participer</button></div></section>`}
        <section class="nn-ranking-layout">
          <article class="nn-card nn-rank-card"><span class="nn-eyebrow">${escapeHtml(period.label)}</span><strong>${rankingSettings.enabled ? rankLabel(result) : "—"}</strong><h3>Rang communautaire</h3><p>${escapeHtml(rankingSettings.enabled ? rankDetail(result) : `Le rang apparaît à partir de ${RANK_CONFIG.minimumParticipants || 5} participants comparables.`)}</p><small>${escapeHtml(rankingState.state === "error" ? rankingState.message : `Cohorte : ${model.student.program}${cohortKey().endsWith("vcod") ? " · VCOD" : ""}`)}</small></article>
          <section class="nn-card"><div class="nn-card-head"><div><span class="nn-eyebrow">Détail filtré</span><h3>Compétences</h3></div></div><div class="nn-rank-list">${period.competencies.map(item => {const score=item.calculatedAverage??item.average;const rank=rankingState.competencies[`competency-${slug(item.title||item.code)}`];return `<div><span><strong>${escapeHtml(item.title||item.code)}</strong><small>${display(score,"/20")}</small></span><b>${rankingSettings.enabled?rankLabel(rank):"—"}</b></div>`;}).join("") || emptyInline("Aucune compétence publiée")}</div></section>
        </section>
        <section class="nn-card nn-device-card"><div class="nn-card-head"><div><span class="nn-eyebrow">Identité anonyme partagée</span><h3>Mes appareils</h3></div><div class="nn-device-actions"><button class="nn-secondary" data-action="create-pairing">Ajouter un appareil</button></div></div>
          ${pairingState.code ? `<div class="nn-pairing-box"><div><strong>Copiez ce code sur le nouvel appareil</strong><code>${escapeHtml(pairingState.code)}</code><small>${escapeHtml(pairingState.message)}</small><button class="nn-link" data-action="copy-pairing">Copier le code</button></div></div>` : pairingState.message ? `<p class="nn-device-message">${escapeHtml(pairingState.message)}</p>` : ""}
          ${rankingSettings.contributorId&&rankingSettings.deviceId?`<p class="nn-current-device-note">Cet appareil est déjà associé. Utilisez le code uniquement sur une autre installation.</p>`:`<div class="nn-join-device"><label><span>Associer cet appareil</span><input type="text" data-pairing-input placeholder="narval-pair…" autocomplete="off" spellcheck="false"></label><button class="nn-primary-action" data-action="join-pairing">Associer</button></div>`}
          <div class="nn-device-list">${deviceState.devices.map(device=>{const isCurrent=device.isCurrent===true||device.deviceIdHash===deviceState.currentDeviceIdHash;return `<div class="nn-device-row ${device.revokedAt?"revoked":""}"><div><strong>${escapeHtml(device.label||"Appareil")}${isCurrent?" · cet appareil":""}</strong><small>${device.revokedAt?"Révoqué":`Dernière activité ${escapeHtml(new Date(device.lastSeenAt).toLocaleString("fr-FR"))}`}</small></div>${!device.revokedAt&&!isCurrent?`<button data-revoke-device="${escapeHtml(device.deviceIdHash)}">Révoquer</button>`:""}</div>`;}).join("")||emptyInline("Aucun appareil associé")}</div>
          ${deviceState.message?`<p class="nn-device-message">${escapeHtml(deviceState.message)}</p>`:""}
        </section>
        ${rankingSettings.enabled?`<div class="nn-card nn-contribution-management"><div><strong>Participation active</strong><p>La suppression efface définitivement votre contribution, l’identité anonyme, les codes temporaires et tous les appareils associés.</p></div><button class="nn-delete-action" data-action="delete-ranking">Supprimer ma contribution</button></div>`:""}
      </main>`;
  }

  function renderAbsences() {
    const abs = model.absences;
    return `${renderHeader("Absences")}
      <main class="nn-content"><section class="nn-metrics">
        ${metric("Justifiées", display(abs.justified), "Heures déclarées", "green")}
        ${metric("Injustifiées", display(abs.unjustified), "À régulariser", "rose")}
        ${metric("Retards", display(abs.delays), "Signalements", "amber")}
      </section>
      <section class="nn-card"><div class="nn-card-head"><div><span class="nn-eyebrow">Historique</span><h3>Rapport d’absences</h3></div></div>
        ${abs.rows.length ? `<div class="nn-table"><div class="nn-table-row nn-table-head"><span>Date</span><span>Durée</span><span>Matière</span><span>Enseignant</span><span>Statut</span></div>${abs.rows.map(r=>`<div class="nn-table-row"><span>${escapeHtml(r.date)}</span><span>${escapeHtml(r.hours)}</span><span>${escapeHtml(r.subject)}</span><span>${escapeHtml(r.teacher)}</span><span>${escapeHtml(r.status)}</span></div>`).join("")}</div>` : emptyState("Aucune absence enregistrée", "Narval ne signale actuellement aucune ligne d’absence.")}
      </section><div class="nn-notice"><strong>À savoir</strong><p>Le relevé reste provisoire. Les justificatifs doivent être transmis selon les règles et délais de votre département.</p></div></main>`;
  }

  function emptyInline(message) { return `<div class="nn-empty-inline">${escapeHtml(message)}</div>`; }
  function emptyState(title, message) { return `<div class="nn-empty"><span>✓</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`; }

  function render() {
    const app = document.getElementById(APP_ID);
    if (!app || !model) return;
    if (!selectedPeriodData().semesters.length) selectedPeriod = "semester:0";
    const view = activeView === "dashboard" ? renderDashboard() : activeView === "semesters" ? renderSemesters() : activeView === "ranking" ? renderRanking() : renderAbsences();
    app.innerHTML = `${renderSidebar()}<button class="nn-menu-backdrop" data-action="close-menu" aria-label="Fermer le menu"></button><section class="nn-shell">${view}</section>`;
    bindEvents(app);
  }

  function bindEvents(app) {
    app.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {activeView=button.dataset.view;app.classList.remove("menu-open");render();}));
    const chooseSemester = value => {
      selectedPeriod=String(value);
      chrome.storage.local.set({selectedPeriod});
      if(rankingSettings.enabled){
        const key=periodKey();
        rankingState=rankingCache[key]||{state:"loading",periodKey:key,overall:null,competencies:{},modules:{},message:"Chargement du classement…"};
      }
      render();
      if(rankingSettings.enabled)loadRanking();
    };
    app.querySelectorAll("[data-semester]").forEach(button => button.addEventListener("click", () => chooseSemester(button.dataset.semester)));
    app.querySelector("[data-semester-select]")?.addEventListener("change", event => chooseSemester(event.target.value));
    app.querySelector('[data-action="refresh"]')?.addEventListener("click", refresh);
    app.querySelector('[data-action="open-update"]')?.addEventListener("click", () => window.open(updateState.url || UPDATE_CONFIG.downloadUrl, "_blank", "noopener,noreferrer"));
    app.querySelector('[data-action="snooze-update"]')?.addEventListener("click", async () => {
      updateState.snoozedUntil = Date.now() + Math.max(1, Number(UPDATE_CONFIG.snoozeHours) || 24) * 60 * 60 * 1000;
      await chrome.storage.local.set({extensionUpdateSnoozedVersion:updateState.version,extensionUpdateSnoozedUntil:updateState.snoozedUntil});
      render();
    });
    app.querySelector('[data-action="original"]')?.addEventListener("click", () => document.documentElement.classList.toggle("nn-show-original"));
    app.querySelector('[data-action="toggle-ranking"]')?.addEventListener("click", toggleRanking);
    app.querySelector('[data-action="delete-ranking"]')?.addEventListener("click", deleteRankingContribution);
    app.querySelector('[data-action="create-pairing"]')?.addEventListener("click", createDevicePairing);
    app.querySelector('[data-action="join-pairing"]')?.addEventListener("click", () => joinDevicePairing(app.querySelector("[data-pairing-input]")?.value || ""));
    app.querySelector('[data-action="copy-pairing"]')?.addEventListener("click", async () => {await navigator.clipboard.writeText(pairingState.code);pairingState.message="Code copié";render();});
    app.querySelectorAll('[data-action="close-menu"]').forEach(button => button.addEventListener("click", () => app.classList.remove("menu-open")));
    app.querySelectorAll("[data-revoke-device]").forEach(button=>button.addEventListener("click",()=>revokeDevice(button.dataset.revokeDevice)));
    app.querySelector(".nn-mobile-menu")?.addEventListener("click", () => app.classList.toggle("menu-open"));
    app.querySelector(".nn-search")?.addEventListener("input", event => {
      const query = event.target.value.toLowerCase().trim();
      app.querySelectorAll(".nn-module").forEach(row => row.hidden = !row.dataset.search.includes(query));
    });
  }

  async function refresh() {
    const button = document.querySelector('[data-action="refresh"]');
    button?.classList.add("loading");
    syncStatus = { state: "checking", message: "Vérification des changements…" };
    render();
    const fresh = await collectAll();
    const changed = await acceptFreshSnapshot(fresh, model);
    render();
    if (rankingSettings.enabled) changed ? contributeRanking() : loadRanking();
  }

  async function init() {
    if (location.pathname !== "/" && location.pathname !== "/index.php") return;
    const body = document.body || await waitFor(() => document.body, 5000);
    if (!body) return;
    originalTitle = document.title || "Narval";
    const app = document.createElement("div");
    app.id = APP_ID;
    app.innerHTML = `<div class="nn-loading"><div class="nn-loader"></div><strong>Préparation de votre espace</strong><span>Lecture locale des données Narval…</span></div>`;
    body.appendChild(app);
    document.documentElement.classList.add("nn-active");
    document.title = `Mon parcours · ${originalTitle}`;
    const hostPromise = waitFor(() => document.querySelector("releve-but")?.shadowRoot?.querySelector(".releve"), 12000);
    const settings = await chrome.storage.local.get(["lastSnapshot", "lastCheckedAt", "selectedPeriod", "selectedSemester", "rankingEnabled", "rankingContributorId", "rankingDeviceId", "rankingDeviceToken", "rankingDevicesCache", "rankingCache", "extensionUpdateCache", "extensionUpdateSnoozedVersion", "extensionUpdateSnoozedUntil"]);
    if (settings.lastSnapshot?.schemaVersion !== CACHE_SCHEMA) settings.lastSnapshot = null;
    selectedPeriod = typeof settings.selectedPeriod === "string" ? settings.selectedPeriod : Number.isInteger(settings.selectedSemester) ? `semester:${settings.selectedSemester}` : "semester:0";
    rankingSettings = {enabled:settings.rankingEnabled === true,contributorId:settings.rankingContributorId || "",deviceId:settings.rankingDeviceId || "",deviceToken:settings.rankingDeviceToken || ""};
    rankingCache = settings.rankingCache && typeof settings.rankingCache === "object" ? settings.rankingCache : {};
    if(settings.rankingDevicesCache)deviceState=settings.rankingDevicesCache;
    if(rankingSettings.enabled)ensureLocalDevicePreview();
    const identityReady = rankingSettings.enabled
      ? ensureRankingIdentity().catch(error => { rankingState={...rankingState,state:"error",message:error.message}; })
      : Promise.resolve();
    void checkForExtensionUpdate(settings);
    if (settings.lastSnapshot) {
      model = settings.lastSnapshot;
      if(rankingSettings.enabled && rankingCache[periodKey()]) rankingState=rankingCache[periodKey()];
      syncStatus = { state: "checking", message: "Données locales affichées · vérification en cours…" };
      render();
    }
    const host = await hostPromise;
    if (!host) {
      if (!model) {
        app.remove();
        document.documentElement.classList.remove("nn-active");
        document.title = originalTitle;
      }
      return;
    }
    const fresh = await collectAll();
    const changed = await acceptFreshSnapshot(fresh, settings.lastSnapshot || null);
    if(rankingSettings.enabled && rankingCache[periodKey()]) rankingState=rankingCache[periodKey()];
    render();
    if(rankingSettings.enabled){await identityReady;if(changed)await contributeRanking();else await Promise.all([loadRanking(),loadDevices()]);render();}
  }

  init().catch(error => {
    console.error("Narval Nouvelle Interface:", error);
    document.documentElement.classList.remove("nn-active");
  });
})();
