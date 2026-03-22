let selectedRow = null;

function openPopup(){
    document.getElementById("popupOverlay").style.display = "flex";
    document.getElementById("mainpage").style.display = "none";
}

function closePopup(){
    document.getElementById("popupOverlay").style.display = "none";
    document.getElementById("mainpage").style.display = "flex";
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

document.addEventListener("click", function(e){
    if(e.target.closest("#tableBody tr")){
        document.querySelectorAll("#tableBody tr")
        .forEach(r=>r.style.background="");

        selectedRow = e.target.closest("tr");
        selectedRow.style.background="#d5f2ff";
    }
});

let currentTarget = null;

// Open child popup
function openLatLonPopup(type){
    currentTarget = type;
    document.getElementById("latLonPopup").style.display = "flex";
}

// Close child popup
function closeLatLonPopup(){
    document.getElementById("latLonPopup").style.display = "none";
}

// Save values back to main UI
function saveLatLon(){

    const latDeg = document.getElementById("latDeg").value;
    const latMin = document.getElementById("latMin").value;

    const lonDeg = document.getElementById("lonDeg").value;
    const lonMin = document.getElementById("lonMin").value;

    if(currentTarget === "lat"){
        document.getElementById("latBtn").innerText =
            `${latDeg}° ${latMin}' S`;
    }

    if(currentTarget === "lon"){
        document.getElementById("lonBtn").innerText =
            `${lonDeg}° ${lonMin}' E`;
    }

    closeLatLonPopup();
}