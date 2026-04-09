let selectedRow = null;
const DEGREE_SYMBOL = "\u00B0";
let currentCoordinateFormat = "deg-min";

function openPopup(){
    const popupOverlay = document.getElementById("popupOverlay");
    popupOverlay.style.display = "flex";
    const mainPage = document.getElementById("mainpage");

    if (mainPage) {
        mainPage.style.display = "none";
    }
}

function closePopup(){
    const popupOverlay = document.getElementById("popupOverlay");
    const mainPage = document.getElementById("mainpage");

    if (mainPage) {
        popupOverlay.style.display = "none";
        mainPage.style.display = "flex";
    }
}

function addRow(){
    const table = document.getElementById("tableBody");
    const row = table.insertRow();
    row.innerHTML = "<td>New Time</td><td>0</td><td>0</td>";
}

function deleteRow(){
    if(selectedRow){
        selectedRow.remove();
        selectedRow = null;
    }
}

function modifyRow(){

}

function getCoordinateFormatRadio(value){
    return document.querySelector(`input[name="format"][value="${value}"]`);
}

function clampNumber(value, min, max){
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return min;
    }

    return Math.min(Math.max(number, min), max);
}

function formatDateForDisplay(date){
    const day = String(date.getDate()).padStart(2, "0");
    const month = date.toLocaleString("en-NZ", { month: "short" });
    const year = String(date.getFullYear()).slice(-2);

    return `${day} ${month} ${year}`;
}

function formatDateForInput(date){
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function normaliseTimeInput(value){
    const digits = value.replace(/\D/g, "").slice(0, 4);
    return digits.padStart(4, "0");
}

function formatTimeForDisplay(value){
    return `${normaliseTimeInput(value)} Hr`;
}

function parseLkpButtonValue(){
    return parseTimeButtonValue("lkpTimeBtn");
}

function parseTimeButtonValue(buttonId){
    const button = document.getElementById(buttonId);
    const text = button.innerText.trim();
    const match = text.match(/(\d{4})\s*Hr;\s*(\d{2})\s+([A-Za-z]{3})\s+(\d{2})/i);

    if (!match) {
        const now = new Date();
        return {
            date: formatDateForInput(now),
            time: formatTimeForDisplay(now.getHours().toString().padStart(2, "0") + now.getMinutes().toString().padStart(2, "0"))
        };
    }

    const [, time, day, monthText, year] = match;
    const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        .findIndex(month => month.toLowerCase() === monthText.toLowerCase());
    const fullYear = 2000 + Number(year);
    const date = new Date(fullYear, Math.max(monthIndex, 0), Number(day));

    return {
        date: formatDateForInput(date),
        time: formatTimeForDisplay(time)
    };
}

function openTimePopup(buttonId, dateInputId, timeInputId, popupId){
    const current = parseTimeButtonValue(buttonId);

    document.getElementById(dateInputId).value = current.date;
    document.getElementById(timeInputId).value = current.time;
    document.getElementById(popupId).style.display = "flex";
    document.getElementById(timeInputId).focus();
    document.getElementById(timeInputId).select();
}

function closeTimePopup(popupId){
    document.getElementById(popupId).style.display = "none";
}

function useCurrentTimeForInputs(dateInputId, timeInputId){
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

    document.getElementById(dateInputId).value = formatDateForInput(now);
    document.getElementById(timeInputId).value = formatTimeForDisplay(currentTime);
}

function saveTimeButton(buttonId, dateInputId, timeInputId, popupId){
    const dateValue = document.getElementById(dateInputId).value;
    const timeInput = document.getElementById(timeInputId);
    const safeTime = formatTimeForDisplay(timeInput.value);
    const parsedDate = dateValue ? new Date(`${dateValue}T00:00:00`) : new Date();

    timeInput.value = safeTime;
    document.getElementById(buttonId).innerText = `${safeTime}; ${formatDateForDisplay(parsedDate)}`;
    closeTimePopup(popupId);
}

function openObjectPopup(){
    document.getElementById("objectPopup").style.display = "flex";
}

function closeObjectPopup(){
    document.getElementById("objectPopup").style.display = "none";
}

function openPiwPopup(){
    closeObjectPopup();
    document.getElementById("piwPopup").style.display = "flex";
}

function closePiwPopup(){
    document.getElementById("piwPopup").style.display = "none";
}

function backToObjectPopup(){
    closePiwPopup();
    openObjectPopup();
}

function openLifeRaftPopup(){
    closeObjectPopup();
    document.getElementById("lifeRaftPopup").style.display = "flex";
}

function closeLifeRaftPopup(){
    document.getElementById("lifeRaftPopup").style.display = "none";
}

function backToObjectPopupFromLifeRaft(){
    closeLifeRaftPopup();
    openObjectPopup();
}

function openSurvivalCraftPopup(){
    closeObjectPopup();
    document.getElementById("survivalCraftPopup").style.display = "flex";
}

function closeSurvivalCraftPopup(){
    document.getElementById("survivalCraftPopup").style.display = "none";
}

function backToObjectPopupFromSurvivalCraft(){
    closeSurvivalCraftPopup();
    openObjectPopup();
}

function openPersonPoweredCraftPopup(){
    closeObjectPopup();
    document.getElementById("personPoweredCraftPopup").style.display = "flex";
}

function closePersonPoweredCraftPopup(){
    document.getElementById("personPoweredCraftPopup").style.display = "none";
}

function backToObjectPopupFromPersonPoweredCraft(){
    closePersonPoweredCraftPopup();
    openObjectPopup();
}

function openPowerDrivenVesselsPopup(){
    closeObjectPopup();
    document.getElementById("powerDrivenVesselsPopup").style.display = "flex";
}

function closePowerDrivenVesselsPopup(){
    document.getElementById("powerDrivenVesselsPopup").style.display = "none";
}

function backToObjectPopupFromPowerDrivenVessels(){
    closePowerDrivenVesselsPopup();
    openObjectPopup();
}

function openSailingVesselsPopup(){
    closeObjectPopup();
    document.getElementById("sailingVesselsPopup").style.display = "flex";
}

function closeSailingVesselsPopup(){
    document.getElementById("sailingVesselsPopup").style.display = "none";
}

function backToObjectPopupFromSailingVessels(){
    closeSailingVesselsPopup();
    openObjectPopup();
}

function openCommercialFishingVesselsPopup(){
    closeObjectPopup();
    document.getElementById("commercialFishingVesselsPopup").style.display = "flex";
}

function closeCommercialFishingVesselsPopup(){
    document.getElementById("commercialFishingVesselsPopup").style.display = "none";
}

function backToObjectPopupFromCommercialFishingVessels(){
    closeCommercialFishingVesselsPopup();
    openObjectPopup();
}

function openImmigrationVesselPopup(){
    closeObjectPopup();
    document.getElementById("immigrationVesselPopup").style.display = "flex";
}

function closeImmigrationVesselPopup(){
    document.getElementById("immigrationVesselPopup").style.display = "none";
}

function backToObjectPopupFromImmigrationVessel(){
    closeImmigrationVesselPopup();
    openObjectPopup();
}

function openOtherTargetsPopup(){
    closeObjectPopup();
    document.getElementById("otherTargetsPopup").style.display = "flex";
}

function closeOtherTargetsPopup(){
    document.getElementById("otherTargetsPopup").style.display = "none";
}

function backToObjectPopupFromOtherTargets(){
    closeOtherTargetsPopup();
    openObjectPopup();
}

function selectObject(objectName){
    document.getElementById("objectBtn").innerText = objectName;
    closePiwPopup();
    closeLifeRaftPopup();
    closeSurvivalCraftPopup();
    closePersonPoweredCraftPopup();
    closePowerDrivenVesselsPopup();
    closeSailingVesselsPopup();
    closeCommercialFishingVesselsPopup();
    closeImmigrationVesselPopup();
    closeOtherTargetsPopup();
    closeObjectPopup();
}

function setCoordinateFormat(format){
    currentCoordinateFormat = format;

    const minutesEnabled = format !== "deg";
    const secondsEnabled = format === "deg-min-sec";

    ["latMin", "lonMin"].forEach(id => {
        const input = document.getElementById(id);
        input.disabled = !minutesEnabled;
    });

    ["latSec", "lonSec"].forEach(id => {
        const input = document.getElementById(id);
        input.disabled = !secondsEnabled;
    });
}

document.addEventListener("click", function(e){
    if(e.target.closest("#tableBody tr")){
        document.querySelectorAll("#tableBody tr")
            .forEach(r => r.style.background = "");

        selectedRow = e.target.closest("tr");
        selectedRow.style.background = "#d5f2ff";
    }
});

let currentTarget = "lat";

function parseCoordinate(buttonId, fallbackHemisphere){
    const button = document.getElementById(buttonId);
    const text = button.innerText.replace(/\s+/g, " ").trim();
    const dmsMatch = text.match(/(\d+)\D+(\d+(?:\.\d+)?)'\s+(\d+(?:\.\d+)?)"\s*([NSEW])?/i);

    if (dmsMatch) {
        return {
            format: "deg-min-sec",
            degrees: dmsMatch[1],
            minutes: Math.round(clampNumber(dmsMatch[2], 0, 59)).toString().padStart(2, "0"),
            seconds: clampNumber(dmsMatch[3], 0, 59.999).toFixed(3).padStart(6, "0"),
            hemisphere: (dmsMatch[4] || fallbackHemisphere).toUpperCase()
        };
    }

    const degMinMatch = text.match(/(\d+)\D+(\d+(?:\.\d+)?)'\s*([NSEW])?/i);

    if (degMinMatch) {
        return {
            format: "deg-min",
            degrees: degMinMatch[1],
            minutes: Math.round(clampNumber(degMinMatch[2], 0, 59)).toString().padStart(2, "0"),
            seconds: "00.000",
            hemisphere: (degMinMatch[3] || fallbackHemisphere).toUpperCase()
        };
    }

    const degMatch = text.match(/(\d+)\D+\s*([NSEW])?/i);

    if (degMatch) {
        return {
            format: "deg",
            degrees: degMatch[1],
            minutes: "00",
            seconds: "00.000",
            hemisphere: (degMatch[2] || fallbackHemisphere).toUpperCase()
        };
    }

    return {
        format: currentCoordinateFormat,
        degrees: "00",
        minutes: "00",
        seconds: "00.000",
        hemisphere: fallbackHemisphere
    };
}

function formatCoordinate(degrees, minutes, seconds, hemisphere, format){
    if (format === "deg") {
        return `${degrees}${DEGREE_SYMBOL} ${hemisphere}`;
    }

    if (format === "deg-min-sec") {
        return `${degrees}${DEGREE_SYMBOL} ${minutes}' ${seconds}" ${hemisphere}`;
    }

    return `${degrees}${DEGREE_SYMBOL} ${minutes}' ${hemisphere}`;
}

function syncPopupFields(){
    const latitude = parseCoordinate("latBtn", "S");
    const longitude = parseCoordinate("lonBtn", "E");
    const format = latitude.format || longitude.format || "deg-min";

    document.getElementById("latDeg").value = latitude.degrees;
    document.getElementById("latMin").value = latitude.minutes;
    document.getElementById("latSec").value = latitude.seconds;
    document.getElementById("lonDeg").value = longitude.degrees;
    document.getElementById("lonMin").value = longitude.minutes;
    document.getElementById("lonSec").value = longitude.seconds;

    currentCoordinateFormat = format;
    const selectedRadio = getCoordinateFormatRadio(format);

    if (selectedRadio) {
        selectedRadio.checked = true;
    }

    setCoordinateFormat(format);
}

function openLatLonPopup(type){
    currentTarget = type;
    syncPopupFields();
    document.getElementById("latLonPopup").style.display = "flex";

    const focusId = currentTarget === "lon" ? "lonDeg" : "latDeg";
    document.getElementById(focusId).focus();
    document.getElementById(focusId).select();
}

function openLatitudePopup(){
    openLatLonPopup("lat");
}

function openLongitudePopup(){
    openLatLonPopup("lon");
}

function closeLatLonPopup(){
    document.getElementById("latLonPopup").style.display = "none";
}

function openLkpTimePopup(){
    openTimePopup("lkpTimeBtn", "lkpDate", "lkpTimeInput", "lkpTimePopup");
}

function closeLkpTimePopup(){
    closeTimePopup("lkpTimePopup");
}

function useCurrentLkpDateTime(){
    useCurrentTimeForInputs("lkpDate", "lkpTimeInput");
}

function saveLkpTime(){
    saveTimeButton("lkpTimeBtn", "lkpDate", "lkpTimeInput", "lkpTimePopup");
}

function openArrivalTimePopup(){
    openTimePopup("arrivalTimeBtn", "arrivalDate", "arrivalTimeInput", "arrivalTimePopup");
}

function closeArrivalTimePopup(){
    closeTimePopup("arrivalTimePopup");
}

function useCurrentArrivalDateTime(){
    useCurrentTimeForInputs("arrivalDate", "arrivalTimeInput");
}

function saveArrivalTime(){
    saveTimeButton("arrivalTimeBtn", "arrivalDate", "arrivalTimeInput", "arrivalTimePopup");
}

document.addEventListener("input", function(e){
    if (e.target.id === "lkpTimeInput" || e.target.id === "arrivalTimeInput") {
        const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
        e.target.value = digits ? `${digits} Hr` : "";
    }
});

function saveLatLon(){
    const latDegValue = clampNumber(document.getElementById("latDeg").value, 0, 90);
    const lonDegValue = clampNumber(document.getElementById("lonDeg").value, 0, 180);
    const latDeg = Math.round(latDegValue).toString().padStart(2, "0");
    const latMin = Math.round(clampNumber(document.getElementById("latMin").value, 0, 59))
        .toString()
        .padStart(2, "0");
    const latSec = clampNumber(document.getElementById("latSec").value, 0, 59.999)
        .toFixed(3)
        .padStart(6, "0");
    const lonDeg = Math.round(lonDegValue).toString().padStart(3, "0");
    const lonMin = Math.round(clampNumber(document.getElementById("lonMin").value, 0, 59))
        .toString()
        .padStart(2, "0");
    const lonSec = clampNumber(document.getElementById("lonSec").value, 0, 59.999)
        .toFixed(3)
        .padStart(6, "0");

    document.getElementById("latDeg").value = latDeg;
    document.getElementById("latMin").value = latMin;
    document.getElementById("latSec").value = latSec;
    document.getElementById("lonDeg").value = lonDeg;
    document.getElementById("lonMin").value = lonMin;
    document.getElementById("lonSec").value = lonSec;

    document.getElementById("latBtn").innerText =
        formatCoordinate(latDeg, latMin, latSec, "S", currentCoordinateFormat);
    document.getElementById("lonBtn").innerText =
        formatCoordinate(lonDeg, lonMin, lonSec, "E", currentCoordinateFormat);

    closeLatLonPopup();
}
