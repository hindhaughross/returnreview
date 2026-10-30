var client = ZAFClient.init();

const VIEW_ID = 6288185996831;
const MAX_PARALLEL = 5;

let analysedTickets = [];
let confirmedTickets = [];
let stopRequested = false;

const KNOWN_LEASE_COMPANIES = [
    { name: "Lex Autolease", aliases: ["lex autolease", "lexautolease", "northumbria@lexautolease.co.uk"] },
    { name: "VWFS", aliases: ["vwfs", "vw fleet", "vw fleet solutions"] },
    { name: "Arval", aliases: ["arval", "arval uk", "arval uk ltd"] },
    { name: "Alphabet", aliases: ["alphabet", "alphabet leasing"] },
    { name: "Leasys", aliases: ["leasys", "leasys uk"] },
    { name: "Hertz Lease", aliases: ["hertz lease", "hertz"] },
    { name: "Ayvens", aliases: ["ayvens", "ayvens uk"] },
    { name: "Novuna", aliases: ["novuna", "novuna vehicle solutions"] },
    { name: "Sainsbury's Motor Finance", aliases: ["sainsbury's motor finance", "sainsburys motor finance", "sainsbury's"] }
];

document.addEventListener("DOMContentLoaded", () => {

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

    const exportBtn =
        document.getElementById("exportBtn");

    if (exportBtn) {
        exportBtn.addEventListener(
            "click",
            exportCSV
        );
    }

    const showAllBtn =
        document.getElementById(
            "showAllBtn"
        );

    if (showAllBtn) {
        showAllBtn.addEventListener(
            "click",
            showAllTickets
        );
    }

    initialiseFilters();
});

function getKnownLeaseCompanyNameFromText(text) {
    if (!text) return "";

    const lower = text.toLowerCase();

    for (const company of KNOWN_LEASE_COMPANIES) {
        if (company.aliases.some(alias => lower.includes(alias.toLowerCase()))) {
            return company.name;
        }
    }

    const signatureMatch = text.match(/(?:Regards|Kind regards|Best regards|Many thanks|Thanks)[\s\S]{0,250}(?:\n|<br\s*\/?>)([A-Za-z0-9&' .-]+(?:Ltd|Limited|PLC|LLP|Group|Leasing|Fleet|Services|Finance))/i);
    if (signatureMatch && signatureMatch[1]) {
        const candidate = signatureMatch[1].trim();
        if (candidate.length > 2 && !/^(regards|kind regards|best regards|many thanks|thanks)$/i.test(candidate)) {
            return candidate;
        }
    }

    const emailMatch = text.match(/[A-Z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i);
    if (emailMatch && emailMatch[1]) {
        const domain = emailMatch[1].toLowerCase();
        for (const company of KNOWN_LEASE_COMPANIES) {
            if (company.aliases.some(alias => alias.toLowerCase().includes(domain) || domain.includes(alias.toLowerCase()))) {
                return company.name;
            }
        }
    }

    return "";
}

function extractLeaseCompanyName(text, ticket = {}) {
    const candidateFromTicket =
        ticket.organization_name ||
        ticket.organization?.name ||
        ticket.organizationName ||
        "";

    if (candidateFromTicket && candidateFromTicket.trim().length) {
        return candidateFromTicket.trim();
    }

    const knownInText = getKnownLeaseCompanyNameFromText(text || "");
    if (knownInText) {
        return knownInText;
    }

    return "";
}

async function analyseView() {

    try {

        stopRequested = false;

        resetDashboard();

        updateProgress(
            0,
            "Loading tickets..."
        );

        let tickets = [];
        let nextUrl =
            `/api/v2/views/${VIEW_ID}/tickets.json`;

        while (nextUrl) {

            const response =
                await client.request({
                    url: nextUrl,
                    type: "GET"
                });

            if (response.tickets) {

                tickets = tickets.concat(
                    response.tickets
                );
            }

            if (response.next_page) {

                nextUrl =
                    response.next_page.replace(
                        "https://fleetsolutions.zendesk.com",
                        ""
                    );

            } else {

                nextUrl = null;
            }
        }

        tickets = tickets.filter(
            ticket => ticket.status !== "solved"
        );

        if (!tickets.length) {

            updateProgress(
                100,
                "No active tickets found"
            );

            return;
        }

        updateResultsCount(
            `${tickets.length} tickets found`
        );

        let processed = 0;

        for (
            let i = 0;
            i < tickets.length;
            i += MAX_PARALLEL
        ) {

            if (stopRequested) {

                updateProgress(
                    0,
                    `Stopped after ${processed} tickets`
                );

                break;
            }

            const batch =
                tickets.slice(
                    i,
                    i + MAX_PARALLEL
                );

            await Promise.all(

                batch.map(
                    async ticket => {

                        try {

                            const comments =
                                await client.request({
                                    url: `/api/v2/tickets/${ticket.id}/comments.json`,
                                    type: "GET"
                                });

                            const conversation =
                                comments.comments
                                    .map(
                                        c => c.body || ""
                                    )
                                    .join("\n\n");

                            const result =
                                await classifyTicket(
                                    conversation,
                                    ticket
                                );

                            // Background: normalize and persist date fields to ticket custom fields
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

                            analysedTickets.push({
                                ticket,
                                result
                            });

                            renderTicket(
                                ticket,
                                result
                            );

                        }
                        catch (err) {

                            console.error(
                                "Ticket error",
                                ticket.id,
                                err
                            );
                        }
                        finally {

                            processed++;

                            const percent =
                                Math.round(
                                    (
                                        processed /
                                        tickets.length
                                    ) * 100
                                );

                            updateProgress(
                                percent,
                                `${processed} of ${tickets.length} analysed`
                            );
                        }
                    }
                )
            );
        }

        if (!stopRequested) {

            updateProgress(
                100,
                `Analysis complete (${processed} tickets)`
            );
        }

    }
    catch (err) {

        console.error(err);

        alert(
            "Error analysing tickets. Check browser console."
        );
    }
}

function initialiseFilters() {

    document
        .querySelectorAll(".summary .card")
        .forEach(card => {

            card.addEventListener(
                "click",
                () => {

                    const filter =
                        card.dataset.filter;

                    document
                        .querySelectorAll(".summary .card")
                        .forEach(c =>
                            c.classList.remove("active")
                        );

                    card.classList.add("active");

                    document
                        .querySelectorAll(".ticketCard")
                        .forEach(ticket => {

                            if (
                                ticket.dataset.status === filter
                            ) {

                                ticket.style.display = "";

                            } else {

                                ticket.style.display = "none";
                            }
                        });
                }
            );
        });
}

function showAllTickets() {

    document
        .querySelectorAll(".summary .card")
        .forEach(card =>
            card.classList.remove("active")
        );

    document
        .querySelectorAll(".ticketCard")
        .forEach(ticket =>
            ticket.style.display = ""
        );
}

function resetDashboard() {

    analysedTickets = [];
    confirmedTickets = [];

    document.getElementById(
        "ticketContainer"
    ).innerHTML = "";

    document.getElementById(
        "confirmedCount"
    ).innerText = "0";

    document.getElementById(
        "failedCount"
    ).innerText = "0";

    document.getElementById(
        "reviewCount"
    ).innerText = "0";

    updateResultsCount(
        "No tickets analysed"
    );

    updateProgress(
        0,
        "Ready"
    );
}

async function classifyTicket(text, ticket = {}) {

    const response =
        await fetch(
            AI_CONFIG.ENDPOINT,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                    "api-key":
                        AI_CONFIG.KEY
                },
                body: JSON.stringify({
                    messages: [
                        {
                            role: "system",
                            content: AI_PROMPT
                        },
                        {
                            role: "user",
                            content: text
                        }
                    ],
                    temperature: 0,
                    max_tokens: 1000
                })
            }
        );

    const data =
        await response.json();

    if (!response.ok) {

        console.error(
            "AI Error",
            data
        );

        throw new Error(
            data.error?.message ||
            "AI request failed"
        );
    }

    if (
        !data.choices ||
        !data.choices.length
    ) {

        throw new Error(
            "No AI response returned"
        );
    }

    let content =
        data.choices[0].message.content
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

    const result =
        JSON.parse(content);

    const inferredLeaseCompanyName = extractLeaseCompanyName(text, ticket);
    if (inferredLeaseCompanyName) {
        result.lease_company_name = inferredLeaseCompanyName;
    }

    // ———————— Deterministic recency checks ————————
    try {
        const recentWindow = 2000; // characters from the end of the conversation to prioritise
        const recentText = text ? text.slice(-recentWindow).toLowerCase() : "";

        // Failure phrases which should force a terminal Failed Booking
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
    // ———————— End deterministic checks ————————

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

    if (
        result.status === "Confirmed" &&
        result.fleet_request_found === false
    ) {

        result.status = "Review Required";
        result.review_required = true;
        result.confidence = 70;
        result.reason = "Fleet request not found";
    }

    const reg =
        (result.registration || "")
            .replace(/\s+/g, "")
            .toUpperCase();

    const validStandard =
        /^[A-Z]{2}[0-9]{2}[A-Z]{3}$/.test(reg);

    const validNI =
        /^[A-Z]{3}[0-9]{4}$/.test(reg);

    result.registration_valid =
        validStandard ||
        validNI;

    if (
        result.registration &&
        !result.registration_valid
    ) {

        result.status = "Review Required";
        result.review_required = true;
        result.confidence = 70;
        result.reason = "Possible private registration detected";
    }

    return result;
}

function getLeaseCompanyDisplay(result, ticket) {
    const fromResult = result?.lease_company_name;
    if (fromResult && fromResult.trim()) {
        return fromResult.trim();
    }

    const fromTicket = ticket?.organization_name || ticket?.organization?.name || ticket?.organizationName;
    if (fromTicket && fromTicket.trim()) {
        return fromTicket.trim();
    }

    return "-";
}

function renderTicket(ticket, result) {

    const container =
        document.getElementById(
            "ticketContainer"
        );

    let status =
        result.status ||
        "Review Required";

    if (
        result.confidence < 80 &&
        status !== "Failed Booking"
    ) {
        status = "Review Required";
    }

    if (result.review_required) {
        status = "Review Required";
    }

    let cardClass =
        "reviewCard";

    let badgeClass =
        "statusReview";

    switch (status) {

        case "Confirmed":
            cardClass =
                "confirmedCard";
            badgeClass =
                "statusConfirmed";

            confirmedTickets.push(
                ticket.id
            );

            ticket.analysisResult =
                result;

            break;

        case "Failed Booking":
            cardClass =
                "failedCard";
            badgeClass =
                "statusFailed";
            break;
    }

    const evidenceHtml =
        result.summary ||
        result.reason ||
        "No summary returned";

    const companyName = getLeaseCompanyDisplay(result, ticket);

    const card =
        document.createElement(
            "div"
        );

    card.className =
        `ticketCard ${cardClass}`;

    card.dataset.status =
        status;

    console.log(
        "Ticket Status:",
        ticket.id,
        status
    );

    card.innerHTML = `
        <div class="ticketHeader">

            <div>

                ${
                    status === "Confirmed"
                    ? `
                    <input
                        type="checkbox"
                        class="ticketCheckbox"
                        value="${ticket.id}">
                    `
                    : ""
                }

                <span
                    class="ticketNumber"
                    data-ticket-id="${ticket.id}">

                    #${ticket.id}

                </span>

            </div>

            <span class="statusBadge ${badgeClass}">
                ${status}
            </span>

        </div>

        <div class="ticketGrid">

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Registration
                </div>
                <div class="ticketFieldValue">
                    ${result.registration || "-"}
                </div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Confidence
                </div>
                <div class="ticketFieldValue">
                    ${result.confidence || 0}%
                </div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Fleet Date
                </div>
                <div class="ticketFieldValue">
                    ${result.fleet_booked_date || "-"}
                </div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Lease Date
                </div>
                <div class="ticketFieldValue">
                    ${result.lease_company_date || "-"}
                </div>
            </div>

            <div class="ticketField">
                <div class="ticketFieldLabel">
                    Lease Company
                </div>
                <div class="ticketFieldValue">
                    ${companyName}
                </div>
            </div>

        </div>

        <div class="evidenceBox">
            <div class="evidenceTitle">
                Summary
            </div>
            ${evidenceHtml}
        </div>
    `;

    container.appendChild(card);

    const ticketLink =
        card.querySelector(
            ".ticketNumber"
        );

    ticketLink.style.cursor =
        "pointer";

    ticketLink.addEventListener(
        "click",
        async () => {

            console.log(
                "Opening ticket",
                ticket.id
            );

            try {

                await client.invoke(
                    "routeTo",
                    "ticket",
                    ticket.id
                );

            } catch (err) {

                console.error(
                    "routeTo failed",
                    err
                );

                window.top.location.href =
                    `/agent/tickets/${ticket.id}`;
            }

        }
    );

    updateCounters(status);

    updateResultsCount(
        `${analysedTickets.length} tickets analysed`
    );
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

    const el =
        document.getElementById(id);

    if (!el) return;

    el.innerText =
        parseInt(
            el.innerText,
            10
        ) + 1;
}

function updateProgress(percent, text) {

    document.getElementById(
        "progressFill"
    ).style.width =
        `${percent}%`;

    document.getElementById(
        "progressText"
    ).innerText =
        text;
}

function updateResultsCount(text) {

    document.getElementById(
        "resultsCount"
    ).innerText =
        text;
}

async function closeSelected() {

    const selected =
        document.querySelectorAll(
            ".ticketCheckbox:checked"
        );

    for (const checkbox of selected) {

        await solveTicket(
            checkbox.value
        );
    }

    alert(
        `${selected.length} ticket(s) closed`
    );
}

async function closeAllConfirmed() {

    const total =
        confirmedTickets.length;

    for (
        const ticketId of [...confirmedTickets]
    ) {

        await solveTicket(
            ticketId
        );
    }

    alert(
        `${total} confirmed ticket(s) closed`
    );
}

function formatUkDate(dateString) {

    if (!dateString) {
        return "";
    }

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateString)) {
        return dateString;
    }

    const date = new Date(dateString);

    if (isNaN(date)) {
        return dateString;
    }

    return date.toLocaleDateString("en-GB");
}

function getCategoryValue(result) {

    if (!result) {
        return "lease_company_confirmation";
    }

    const category =
        result.category ||
        "Lease Company Confirmation";

    switch (category) {

        case "Customer Amendments":
            return "customer_ammendments";

        case "Customer Cancelation":
            return "customer_cancelation";

        case "Aborted Collection":
            return "aborted_collection";

        case "Lease Company Date Change":
            return "lease_company_date_change";

        case "Lease Company Confirmation":
        default:
            return "lease_company_confirmation";
    }
}

async function solveTicket(ticketId) {

    try {

        const analysed =
            analysedTickets.find(
                t =>
                    String(t.ticket.id) ===
                    String(ticketId)
            );

        if (!analysed) {

            console.error(
                "Analysis not found",
                ticketId
            );

            return;
        }

        if (analysed.closed) {

            console.log(
                `Ticket ${ticketId} already closed`
            );

            return;
        }

        const result =
            analysed.result;

        const fleetDate =
            formatUkDate(
                result.fleet_booked_date
            );

        const leaseDate =
            formatUkDate(
                result.lease_company_date
            );

        const categoryValue =
            getCategoryValue(result);

        let internalNote =
            "Ticket closed automatically by Collection App.";

        if (
            result.category ===
            "Lease Company Date Change"
        ) {

            internalNote =
                `Ticket closed: Fleet requested ${fleetDate} and the lease company confirmed an amended collection date of ${leaseDate}.`;

        }
        else if (
            fleetDate &&
            leaseDate
        ) {

            internalNote =
                `Ticket closed: Fleet requested ${fleetDate} and collection was confirmed for the same date.`;

        }
        else if (
            result.summary
        ) {

            internalNote =
                `Ticket closed: ${result.summary}`;
        }

        const customFields = [
            {
                id: 6288766218399,
                value: categoryValue
            }
        ];

        const ticketData =
            await client.request({

                url:
                    `/api/v2/tickets/${ticketId}.json`,

                type: "GET"

            });

        const existingReg =
            ticketData.ticket.custom_fields.find(
                f =>
                    Number(f.id) ===
                    5980606556063
            )?.value;

        if (
            !existingReg &&
            result.registration &&
            result.registration !== "-"
        ) {

            customFields.push({

                id: 5980606556063,

                value:
                    result.registration
                        .replace(/\s+/g, " ")
                        .trim()

            });

        }

        if (leaseDate) {

            customFields.push({

                id: 6288217950111,

                value: leaseDate

            });

        }

        await client.request({

            url:
                `/api/v2/tickets/${ticketId}.json`,

            type: "PUT",

            contentType:
                "application/json",

            data: JSON.stringify({

                ticket: {

                    status: "solved",

                    comment: {

                        body: internalNote,

                        public: false
                    },

                    additional_tags: [
                        "collection_app_closed"
                    ],

                    custom_fields:
                        customFields
                }

            })

        });

        analysed.closed = true;

        confirmedTickets =
            confirmedTickets.filter(
                id =>
                    String(id) !==
                    String(ticketId)
            );

        const confirmedCount =
            document.getElementById(
                "confirmedCount"
            );

        if (confirmedCount) {

            confirmedCount.innerText =
                Math.max(
                    0,
                    parseInt(
                        confirmedCount.innerText,
                        10
                    ) - 1
                );
        }

        const card =
            document
                .querySelector(
                    `.ticketCheckbox[value="${ticketId}"]`
                )
                ?.closest(
                    ".ticketCard"
                );

        if (card) {
            card.remove();
        }

        updateResultsCount(
            `${document.querySelectorAll(".ticketCard").length} tickets remaining`
        );

        console.log(
            `Ticket ${ticketId} closed successfully`
        );

    }
    catch (err) {

        console.error(
            "Unable to close ticket",
            ticketId,
            err
        );
    }
}

function escapeCsvValue(value) {
    const stringValue = String(value ?? "");
    return `"${stringValue.replace(/"/g, '""')}"`;
}

function exportCSV() {

    const rows = [];

    rows.push([
        "Ticket",
        "Registration",
        "Status",
        "Confidence",
        "Lease Company",
        "Summary"
    ]);

    analysedTickets.forEach(
        item => {
            rows.push([
                item.ticket.id,
                item.result.registration || "",
                item.result.status || "",
                item.result.confidence || "",
                getLeaseCompanyDisplay(item.result, item.ticket),
                item.result.summary || item.result.reason || ""
            ]);
        }
    );

    const csv =
        rows
            .map(
                row => row.map(escapeCsvValue).join(",")
            )
            .join("\n");

    const blob =
        new Blob(
            [csv],
            {
                type: "text/csv;charset=utf-8;"
            }
        );

    const link =
        document.createElement("a");

    link.href =
        URL.createObjectURL(blob);

    link.download =
        "ticket-analysis.csv";

    link.click();
}
