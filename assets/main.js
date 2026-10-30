const LEASE_COMPANY_LOOKUP = [
    { name: "ALD Automotive Limited", aliases: ["ald automotive", "ald automotive limited", "ald"], tags: ["ald"] },
    { name: "ALPHABET (UK) FLEET MANAGEMENT LTD", aliases: ["alphabet", "alphabet uk", "alphabet fleet management", "alphabet (uk) fleet management ltd"], tags: ["alphabet"] },
    { name: "ARNOLD CLARK FINANCE LTD", aliases: ["arnold clark finance", "arnold clark", "acvm"], tags: ["acvm"] },
    { name: "Arval Uk Ltd", aliases: ["arval", "arval uk", "arval uk ltd"], tags: ["arval"] },
    { name: "Athlon", aliases: ["athlon"], tags: ["athlon"] },
    { name: "Kinto", aliases: ["kinto", "kinto uk", "kinto gca helpdesk", "driver support executive, kinto"], tags: ["kinto"] },
    { name: "Ayvens", aliases: ["ayvens", "ayvens uk"], tags: ["ayvens"] },
    { name: "Lex Autolease", aliases: ["lex autolease", "lex", "lexautolease"], tags: ["lex"] },
    { name: "Lookers Leasing", aliases: ["lookers leasing", "lookers"], tags: ["lookers_leasing"] },
    { name: "Novuna Vehicle Solutions", aliases: ["novuna vehicle solutions", "novuna"], tags: ["novuna"] },
    { name: "Sinclair", aliases: ["sinclair"], tags: ["sinclair"] },
    { name: "TCH Leasing", aliases: ["tch leasing", "tch"], tags: ["tch"] },
    { name: "VOLKSWAGEN GROUP UNITED KINGDOM LTD", aliases: ["volkswagen group united kingdom ltd", "vwfs", "vwfs1", "vw fleet solutions", "vw fleet"], tags: ["vwfs1"] }
];

function normaliseLeaseCompanyText(value) {
    if (!value) return "";
    return String(value)
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function matchKnownLeaseCompanyName(value) {
    if (!value) return "";

    const normalized = normaliseLeaseCompanyText(value);
    if (!normalized) return "";

    for (const company of LEASE_COMPANY_LOOKUP) {
        const aliases = company.aliases.map(normaliseLeaseCompanyText);
        const tags = company.tags.map(tag => normaliseLeaseCompanyText(tag));

        const isMatch = aliases.some(alias => normalized.includes(alias) || alias.includes(normalized)) ||
            tags.some(tag => normalized.includes(tag) || tag.includes(normalized));

        if (isMatch) {
            return company.name;
        }
    }

    return "";
}

function getTicketLeaseCompanyCandidate(ticket, text) {
    const candidates = [];

    if (ticket?.organization_name) candidates.push(ticket.organization_name);
    if (ticket?.organization?.name) candidates.push(ticket.organization.name);
    if (ticket?.organizationName) candidates.push(ticket.organizationName);
    if (Array.isArray(ticket?.tags)) {
        candidates.push(...ticket.tags);
    }

    if (text) {
        const signatureMatches = [...text.matchAll(/(?:Regards|Kind regards|Best regards|Many thanks|Thanks)[\s\S]{0,200}(?:\n|<br\s*\/?>)([A-Za-z0-9&' .-]+)/gi)];
        for (const match of signatureMatches) {
            if (match[1]) candidates.push(match[1]);
        }

        const emailMatches = [...text.matchAll(/[A-Z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi)];
        for (const match of emailMatches) {
            if (match[1]) candidates.push(match[1]);
        }
    }

    for (const candidate of candidates) {
        const result = matchKnownLeaseCompanyName(candidate);
        if (result) {
            return result;
        }
    }

    return "";
}

function getLeaseCompanyDisplay(result, ticket) {
    const direct = result?.lease_company_name;
    const directMatch = direct ? matchKnownLeaseCompanyName(direct) : "";
    if (directMatch) {
        return directMatch;
    }

    const inferred = getTicketLeaseCompanyCandidate(ticket, ticket?.comment || "");
    if (inferred) {
        return inferred;
    }

    return "";
}

function rememberScrollPosition() {
    const y = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
    try {
        sessionStorage.setItem("returnReviewAppScrollY", String(Math.round(y)));
    } catch (err) {
        console.warn("Unable to save scroll position", err);
    }
}

function restoreScrollPosition() {
    try {
        const savedY = Number(sessionStorage.getItem("returnReviewAppScrollY") || "0");
        if (!Number.isFinite(savedY)) return;

        requestAnimationFrame(() => {
            window.scrollTo({
                top: savedY,
                behavior: "auto"
            });
        });
    } catch (err) {
        console.warn("Unable to restore scroll position", err);
    }
}

const originalClassifyTicket = typeof classifyTicket === "function" ? classifyTicket : null;

if (originalClassifyTicket) {
    // no-op placeholder to preserve existing function lifecycle; actual logic remains below
}

var client = ZAFClient.init();

const VIEW_ID = 6288185996831;
const MAX_PARALLEL = 5;
const SCROLL_KEY = "returnReviewAppScrollY";
const TICKET_CACHE_KEY = "returnReviewTicketCacheV1";

let analysedTickets = [];
let confirmedTickets = [];
let stopRequested = false;

function safeLocalStorageGet(key) {
    try {
        return window.localStorage.getItem(key);
    } catch (err) {
        return null;
    }
}

function safeLocalStorageSet(key, value) {
    try {
        window.localStorage.setItem(key, value);
    } catch (err) {
        console.warn("Local storage unavailable", err);
    }
}

function loadTicketCache() {
    const raw = safeLocalStorageGet(TICKET_CACHE_KEY);
    if (!raw) return {};

    try {
        return JSON.parse(raw);
    } catch (err) {
        console.warn("Unable to read cache", err);
        return {};
    }
}

function saveTicketCache(cache) {
    safeLocalStorageSet(TICKET_CACHE_KEY, JSON.stringify(cache));
}

function buildTicketSnapshot(ticket, comments) {
    const commentItems = (comments?.comments || []).map(comment => ({
        id: comment.id,
        created_at: comment.created_at,
        body: (comment.body || "").replace(/\s+/g, " ").trim()
    }));

    return JSON.stringify({
        id: ticket.id,
        status: ticket.status,
        updated_at: ticket.updated_at,
        tags: (ticket.tags || []).slice().sort(),
        custom_fields: (ticket.custom_fields || [])
            .map(field => ({
                id: field.id,
                value: field.value
            }))
            .sort((a, b) => Number(a.id) - Number(b.id)),
        comments: commentItems
    });
}

function readCachedResult(ticket, comments) {
    const cache = loadTicketCache();
    const entry = cache[String(ticket.id)];
    if (!entry) return null;

    const snapshot = buildTicketSnapshot(ticket, comments);
    if (entry.snapshot !== snapshot) return null;

    return entry.result;
}

function writeCachedResult(ticket, comments, result) {
    const cache = loadTicketCache();
    cache[String(ticket.id)] = {
        snapshot: buildTicketSnapshot(ticket, comments),
        result,
        scannedAt: Date.now()
    };
    saveTicketCache(cache);
}

document.addEventListener("DOMContentLoaded", () => {
    restoreScrollPosition();
    window.addEventListener("focus", restoreScrollPosition);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) restoreScrollPosition();
    });
    window.addEventListener("scroll", rememberScrollPosition, { passive: true });
    window.addEventListener("beforeunload", rememberScrollPosition);
    window.addEventListener("pagehide", rememberScrollPosition);

    document
        .getElementById("analyseBtn")
        .addEventListener("click", analyseView);

    document
        .getElementById("stopBtn")
        .addEventListener("click", () => {
            stopRequested = true;
        });

    document
        .getElementById("closeSelectedBtn")
        .addEventListener("click", closeSelected);

    document
        .getElementById("closeAllBtn")
        .addEventListener("click", closeAllConfirmed);

    const exportBtn = document.getElementById("exportBtn");
    if (exportBtn) {
        exportBtn.addEventListener("click", exportCSV);
    }

    const showAllBtn = document.getElementById("showAllBtn");
    if (showAllBtn) {
        showAllBtn.addEventListener("click", showAllTickets);
    }

    initialiseFilters();
});

async function analyseView() {

    try {

        stopRequested = false;
        resetDashboard();

        updateProgress(0, "Loading tickets...");

        let tickets = [];
        let nextUrl = `/api/v2/views/${VIEW_ID}/tickets.json`;

        while (nextUrl) {
            const response = await client.request({
                url: nextUrl,
                type: "GET"
            });

            if (response.tickets) {
                tickets = tickets.concat(response.tickets);
            }

            if (response.next_page) {
                nextUrl = response.next_page.replace("https://fleetsolutions.zendesk.com", "");
            } else {
                nextUrl = null;
            }
        }

        tickets = tickets.filter(ticket => ticket.status !== "solved");

        if (!tickets.length) {
            updateProgress(100, "No active tickets found");
            return;
        }

        updateResultsCount(`${tickets.length} tickets found`);

        let processed = 0;

        for (let i = 0; i < tickets.length; i += MAX_PARALLEL) {
            if (stopRequested) {
                updateProgress(0, `Stopped after ${processed} tickets`);
                break;
            }

            const batch = tickets.slice(i, i + MAX_PARALLEL);

            await Promise.all(batch.map(async ticket => {
                try {
                    const comments = await client.request({
                        url: `/api/v2/tickets/${ticket.id}/comments.json`,
                        type: "GET"
                    });

                    const conversation = comments.comments
                        .map(c => c.body || "")
                        .join("\n\n");

                    const cachedResult = readCachedResult(ticket, comments);
                    let result;

                    if (cachedResult) {
                        result = cachedResult;
                    } else {
                        result = await classifyTicket(conversation, ticket);
                        writeCachedResult(ticket, comments, result);
                    }

                    try {
                        const normalizedLeaseDate = formatUkDate(result.lease_company_date || "");
                        if (normalizedLeaseDate) {
                            await client.request({
                                url: `/api/v2/tickets/${ticket.id}.json`,
                                type: "PUT",
                                contentType: "application/json",
                                data: JSON.stringify({
                                    ticket: {
                                        custom_fields: [
                                            { id: 6288217950111, value: normalizedLeaseDate }
                                        ]
                                    }
                                })
                            });
                        }
                    } catch (err) {
                        console.warn(`Background date update failed for ticket ${ticket.id}`, err);
                    }

                    analysedTickets.push({ ticket, result });
                    renderTicket(ticket, result);

                } catch (err) {
                    console.error("Ticket error", ticket.id, err);
                } finally {
                    processed++;
                    const percent = Math.round((processed / tickets.length) * 100);
                    updateProgress(percent, `${processed} of ${tickets.length} analysed`);
                }
            }));
        }

        if (!stopRequested) {
            updateProgress(100, `Analysis complete (${processed} tickets)`);
        }

    } catch (err) {
        console.error(err);
        alert("Error analysing tickets. Check browser console.");
    }
}

function initialiseFilters() {
    document.querySelectorAll(".summary .card").forEach(card => {
        card.addEventListener("click", () => {
            const filter = card.dataset.filter;

            document.querySelectorAll(".summary .card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");

            document.querySelectorAll(".ticketCard").forEach(ticket => {
                ticket.style.display = ticket.dataset.status === filter ? "" : "none";
            });
        });
    });
}

function showAllTickets() {
    document.querySelectorAll(".summary .card").forEach(card => card.classList.remove("active"));
    document.querySelectorAll(".ticketCard").forEach(ticket => ticket.style.display = "");
}

function resetDashboard() {
    analysedTickets = [];
    confirmedTickets = [];

    document.getElementById("ticketContainer").innerHTML = "";
    document.getElementById("confirmedCount").innerText = "0";
    document.getElementById("failedCount").innerText = "0";
    document.getElementById("reviewCount").innerText = "0";

    updateResultsCount("No tickets analysed");
    updateProgress(0, "Ready");
}

async function classifyTicket(text, ticket = {}) {
    const response = await fetch(AI_CONFIG.ENDPOINT, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "api-key": AI_CONFIG.KEY
        },
        body: JSON.stringify({
            messages: [
                { role: "system", content: AI_PROMPT },
                { role: "user", content: text }
            ],
            temperature: 0,
            max_tokens: 1000
        })
    });

    const data = await response.json();

    if (!response.ok) {
        console.error("AI Error", data);
        throw new Error(data.error?.message || "AI request failed");
    }

    if (!data.choices || !data.choices.length) {
        throw new Error("No AI response returned");
    }

    const content = data.choices[0].message.content
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

    const result = JSON.parse(content);

    const inferredLeaseCompanyName = getTicketLeaseCompanyCandidate(ticket, text);
    if (inferredLeaseCompanyName) {
        result.lease_company_name = inferredLeaseCompanyName;
    }

    try {
        const recentWindow = 2000;
        const recentText = text ? text.slice(-recentWindow).toLowerCase() : "";
        const FAILURE_RE = /(fallen through|has fallen through|collection fell through|collection has fallen through|collection failed|failed to collect|booking aborted|booking cancelled|cancelled collect|abortive|arranged collection later)/i;

        if (FAILURE_RE.test(recentText) || FAILURE_RE.test(text)) {
            result.status = "Failed Booking";
            result.confidence = 0;
            result.review_required = false;
            result.reason = result.reason
                ? result.reason + "; Final message indicates collection failed"
                : "Final message indicates collection failed";
            return result;
        }

        const fleetDate = (result.fleet_booked_date || "").trim();
        const leaseDate = (result.lease_company_date || "").trim();

        if (fleetDate && leaseDate && fleetDate !== leaseDate) {
            const ACK_RE = /\b(accepted|agreed|acknowledged|confirmed|i confirm|we accept|we agree|accepted the change|has been amended to|amended to|has been updated to|updated to|changed to|set for|booked in for)\b/i;

            if (!ACK_RE.test(recentText)) {
                result.status = "Review Required";
                result.confidence = 70;
                result.review_required = true;
                result.category = result.category || "Lease Company Date Change";
                result.reason = result.reason
                    ? result.reason + "; Lease date differs from fleet date and no fleet acknowledgement found"
                    : "Lease date differs from fleet date and no fleet acknowledgement found";
            }
        }
    } catch (err) {
        console.warn("Deterministic recency checks failed", err);
    }

    const hasReturnNotify = /RETURN_NOTIFY_LEASECO/i.test(text);

    if (result.status === "Confirmed" && !hasReturnNotify) {
        const aiSummary = (result.summary || "").trim();
        const reg = (result.registration || "").replace(/\s+/g, " ").trim();
        const fleetDate = (result.fleet_booked_date || "").trim();
        const fleetDateFormatted = formatUkDate(fleetDate);
        const fleetDateDisplay = fleetDateFormatted || fleetDate;

        let baseSummary = aiSummary;
        if (!baseSummary) {
            if (reg && fleetDate) {
                baseSummary = `Collection confirmed for ${reg} on ${fleetDateDisplay}.`;
            } else if (fleetDate) {
                baseSummary = `Collection confirmed for ${fleetDateDisplay}.`;
            } else if (reg) {
                baseSummary = `Collection confirmed for ${reg}.`;
            } else {
                baseSummary = `Collection confirmed (details incomplete).`;
            }
        }

        const note = "NHS FLEET BOOKING not present in the email.";
        if (baseSummary.endsWith(".") || baseSummary.endsWith("!")) {
            result.summary = `${baseSummary} ${note}`;
        } else {
            result.summary = `${baseSummary}. ${note}`;
        }

        result.status = "Review Required";
        result.review_required = true;
        result.confidence = 70;
        result.reason = result.reason
            ? result.reason + "; Missing RETURN_NOTIFY_LEASECO — requires human review"
            : "Missing RETURN_NOTIFY_LEASECO — requires human review";
    }

    if (result.status === "Confirmed" && result.fleet_request_found === false) {
        result.status = "Review Required";
        result.review_required = true;
        result.confidence = 70;
        result.reason = "Fleet request not found";
    }

    const reg = (result.registration || "").replace(/\s+/g, "").toUpperCase();
    const validStandard = /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(reg);
    const validNI = /^[A-Z]{3}[0-9]{4}$/.test(reg);
    result.registration_valid = validStandard || validNI;

    if (result.registration && !result.registration_valid) {
        result.status = "Review Required";
        result.review_required = true;
        result.confidence = 70;
        result.reason = "Possible private registration detected";
    }

    return result;
}

function renderTicket(ticket, result) {
    const container = document.getElementById("ticketContainer");

    let status = result.status || "Review Required";

    if (result.confidence < 80 && status !== "Failed Booking") {
        status = "Review Required";
    }

    if (result.review_required) {
        status = "Review Required";
    }

    let cardClass = "reviewCard";
    let badgeClass = "statusReview";

    switch (status) {
        case "Confirmed":
            cardClass = "confirmedCard";
            badgeClass = "statusConfirmed";
            confirmedTickets.push(ticket.id);
            ticket.analysisResult = result;
            break;
        case "Failed Booking":
            cardClass = "failedCard";
            badgeClass = "statusFailed";
            break;
    }

    const evidenceHtml = result.summary || result.reason || "No summary returned";
    const companyName = getLeaseCompanyDisplay(result, ticket);

    const card = document.createElement("div");
    card.className = `ticketCard ${cardClass}`;
    card.dataset.status = status;

    card.innerHTML = `
        <div class="ticketHeader">
            <div>
                ${status === "Confirmed" ? `<input type="checkbox" class="ticketCheckbox" value="${ticket.id}">` : ""}
                <span class="ticketNumber" data-ticket-id="${ticket.id}">#${ticket.id}</span>
            </div>
            <span class="statusBadge ${badgeClass}">${status}</span>
        </div>

        <div class="ticketGrid">
            <div class="ticketField">
                <div class="ticketFieldLabel">Registration</div>
                <div class="ticketFieldValue">${result.registration || "-"}</div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">Confidence</div>
                <div class="ticketFieldValue">${result.confidence || 0}%</div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">Fleet Date</div>
                <div class="ticketFieldValue">${result.fleet_booked_date || "-"}</div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">Lease Date</div>
                <div class="ticketFieldValue">${result.lease_company_date || "-"}</div>
            </div>

            <div class="ticketField leaseCompanyField">
                <div class="ticketFieldLabel">Lease Company</div>
                <div class="ticketFieldValue">${companyName}</div>
            </div>
        </div>

        <div class="evidenceBox">
            <div class="evidenceTitle">Summary</div>
            ${evidenceHtml}
        </div>
    `;

    container.appendChild(card);

    const ticketLink = card.querySelector(".ticketNumber");
    ticketLink.style.cursor = "pointer";

    ticketLink.addEventListener("click", async () => {
        rememberScrollPosition();

        try {
            await client.invoke("routeTo", "ticket", ticket.id);
        } catch (err) {
            console.error("routeTo failed", err);
            window.top.location.href = `/agent/tickets/${ticket.id}`;
        }
    });

    updateCounters(status);
    updateResultsCount(`${analysedTickets.length} tickets analysed`);
}

function updateCounters(status) {
    if (status === "Confirmed") {
        increment("confirmedCount");
        return;
    }

    if (status === "Failed Booking") {
        increment("failedCount");
        return;
    }

    increment("reviewCount");
}

function increment(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerText = parseInt(el.innerText, 10) + 1;
}

function updateProgress(percent, text) {
    document.getElementById("progressFill").style.width = `${percent}%`;
    document.getElementById("progressText").innerText = text;
}

function updateResultsCount(text) {
    document.getElementById("resultsCount").innerText = text;
}

async function closeSelected() {
    const selected = document.querySelectorAll(".ticketCheckbox:checked");
    for (const checkbox of selected) {
        await solveTicket(checkbox.value);
    }
    alert(`${selected.length} ticket(s) closed`);
}

async function closeAllConfirmed() {
    const total = confirmedTickets.length;
    for (const ticketId of [...confirmedTickets]) {
        await solveTicket(ticketId);
    }
    alert(`${total} confirmed ticket(s) closed`);
}

function formatUkDate(dateString) {
    if (!dateString) return "";
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateString)) return dateString;

    const date = new Date(dateString);
    if (isNaN(date)) return dateString;
    return date.toLocaleDateString("en-GB");
}

function getCategoryValue(result) {
    if (!result) return "lease_company_confirmation";

    const category = result.category || "Lease Company Confirmation";

    switch (category) {
        case "Customer Amendments": return "customer_ammendments";
        case "Customer Cancelation": return "customer_cancelation";
        case "Aborted Collection": return "aborted_collection";
        case "Lease Company Date Change": return "lease_company_date_change";
        case "Lease Company Confirmation":
        default: return "lease_company_confirmation";
    }
}

async function solveTicket(ticketId) {
    try {
        const analysed = analysedTickets.find(t => String(t.ticket.id) === String(ticketId));
        if (!analysed) {
            console.error("Analysis not found", ticketId);
            return;
        }

        if (analysed.closed) {
            console.log(`Ticket ${ticketId} already closed`);
            return;
        }

        const result = analysed.result;
        const fleetDate = formatUkDate(result.fleet_booked_date);
        const leaseDate = formatUkDate(result.lease_company_date);
        const categoryValue = getCategoryValue(result);

        let internalNote = "Ticket closed automatically by Collection App.";

        if (result.category === "Lease Company Date Change") {
            internalNote = `Ticket closed: Fleet requested ${fleetDate} and the lease company confirmed an amended collection date of ${leaseDate}.`;
        } else if (fleetDate && leaseDate) {
            internalNote = `Ticket closed: Fleet requested ${fleetDate} and collection was confirmed for the same date.`;
        } else if (result.summary) {
            internalNote = `Ticket closed: ${result.summary}`;
        }

        const customFields = [{ id: 6288766218399, value: categoryValue }];

        const ticketData = await client.request({
            url: `/api/v2/tickets/${ticketId}.json`,
            type: "GET"
        });

        const existingReg = ticketData.ticket.custom_fields.find(f => Number(f.id) === 5980606556063)?.value;

        if (!existingReg && result.registration && result.registration !== "-") {
            customFields.push({
                id: 5980606556063,
                value: result.registration.replace(/\s+/g, " ").trim()
            });
        }

        if (leaseDate) {
            customFields.push({
                id: 6288217950111,
                value: leaseDate
            });
        }

        await client.request({
            url: `/api/v2/tickets/${ticketId}.json`,
            type: "PUT",
            contentType: "application/json",
            data: JSON.stringify({
                ticket: {
                    status: "solved",
                    comment: {
                        body: internalNote,
                        public: false
                    },
                    additional_tags: ["collection_app_closed"],
                    custom_fields: customFields
                }
            })
        });

        analysed.closed = true;
        confirmedTickets = confirmedTickets.filter(id => String(id) !== String(ticketId));

        const confirmedCount = document.getElementById("confirmedCount");
        if (confirmedCount) {
            confirmedCount.innerText = Math.max(0, parseInt(confirmedCount.innerText, 10) - 1);
        }

        const card = document.querySelector(`.ticketCheckbox[value="${ticketId}"]`)?.closest(".ticketCard");
        if (card) card.remove();

        updateResultsCount(`${document.querySelectorAll(".ticketCard").length} tickets remaining`);
        console.log(`Ticket ${ticketId} closed successfully`);
    } catch (err) {
        console.error("Unable to close ticket", ticketId, err);
    }
}

function escapeCsvValue(value) {
    const stringValue = String(value ?? "");
    return `"${stringValue.replace(/"/g, '""')}"`;
}

function exportCSV() {
    const rows = [];
    rows.push(["Ticket", "Registration", "Status", "Confidence", "Lease Company", "Summary"]);

    analysedTickets.forEach(item => {
        rows.push([
            item.ticket.id,
            item.result.registration || "",
            item.result.status || "",
            item.result.confidence || "",
            getLeaseCompanyDisplay(item.result, item.ticket),
            item.result.summary || item.result.reason || ""
        ]);
    });

    const csv = rows.map(row => row.map(escapeCsvValue).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "ticket-analysis.csv";
    link.click();
}
