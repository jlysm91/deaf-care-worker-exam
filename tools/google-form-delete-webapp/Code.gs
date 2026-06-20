const TRIAL_FORM_ID = "";
const TRIAL_FORM_EDIT_URL = "";
const FIREBASE_DATABASE_URL = "https://deaf-for-database-develo-59bf8-default-rtdb.firebaseio.com";
const DELETE_LOG_BASE_PATH = "exams/examTrial/deleteLogs";
const TIME_TOLERANCE_MS = 5 * 60 * 1000;

function doGet() {
  return jsonOutput_({
    ok: true,
    service: "examTrial Google Form delete web app",
    message: "ready"
  });
}

function doPost(e) {
  var payload;
  var requestId = "unknown";
  try {
    payload = parsePayload_(e);
    requestId = String(payload.requestId || requestId);
    if (payload.examId !== "examTrial") {
      throw new Error("Unsupported examId: " + payload.examId);
    }

    var rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length) {
      throw new Error("No rows were provided.");
    }

    var result = deleteMatchingResponses_(rows);
    if (result.notFound.length) {
      throw new Error(
        "Google Form response not found for " +
        result.notFound.map(function(row) { return row.uid || row.name || "(unknown)"; }).join(", ")
      );
    }

    var successLog = {
      status: "success",
      requestId: requestId,
      examId: payload.examId,
      scope: payload.scope || "",
      requestedCount: rows.length,
      deletedCount: result.deletedCount,
      deletedUids: result.deletedUids,
      notFoundCount: 0,
      createdAt: new Date().toISOString()
    };
    writeDeleteLog_(requestId, successLog);
    return jsonOutput_(successLog);
  } catch (error) {
    var errorLog = {
      status: "error",
      requestId: requestId,
      message: error && error.message ? error.message : String(error),
      createdAt: new Date().toISOString()
    };
    writeDeleteLog_(requestId, errorLog);
    return jsonOutput_(errorLog);
  }
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error("Missing POST body.");
  }
  return JSON.parse(e.postData.contents);
}

function getTrialForm_() {
  var activeForm = FormApp.getActiveForm();
  if (activeForm) return activeForm;
  if (TRIAL_FORM_ID) return FormApp.openById(TRIAL_FORM_ID);
  if (TRIAL_FORM_EDIT_URL) return FormApp.openByUrl(TRIAL_FORM_EDIT_URL);
  throw new Error("Set TRIAL_FORM_ID or bind this script to the target Google Form.");
}

function deleteMatchingResponses_(rows) {
  var form = getTrialForm_();
  var responses = form.getResponses();
  var used = {};
  var deletedUids = [];
  var notFound = [];

  rows.forEach(function(row) {
    var match = null;
    for (var i = 0; i < responses.length; i++) {
      var response = responses[i];
      var responseId = response.getId();
      if (used[responseId]) continue;
      if (responseMatchesRow_(response, row)) {
        match = response;
        break;
      }
    }

    if (!match) {
      notFound.push(row);
      return;
    }

    form.deleteResponse(match.getId());
    used[match.getId()] = true;
    deletedUids.push(row.uid || "");
  });

  return {
    deletedCount: deletedUids.length,
    deletedUids: deletedUids,
    notFound: notFound
  };
}

function responseMatchesRow_(response, row) {
  var rowTime = Number(row.timestamp || 0);
  if (!rowTime) return false;
  var responseTime = response.getTimestamp().getTime();
  if (Math.abs(responseTime - rowTime) > TIME_TOLERANCE_MS) return false;

  var responseName = normalizePersonName_(extractResponseName_(response));
  var rowNames = [row.name, row.countName]
    .filter(function(value) { return value !== null && value !== undefined && String(value).trim(); })
    .map(function(value) { return normalizePersonName_(value); });

  return rowNames.indexOf(responseName) !== -1;
}

function extractResponseName_(response) {
  var itemResponses = response.getItemResponses();
  var titleHints = ["이름", "성명", "성함", "응시자", "학습자", "name"];

  for (var i = 0; i < itemResponses.length; i++) {
    var title = String(itemResponses[i].getItem().getTitle() || "").toLowerCase();
    for (var j = 0; j < titleHints.length; j++) {
      if (title.indexOf(titleHints[j].toLowerCase()) !== -1) {
        return stringifyAnswer_(itemResponses[i].getResponse());
      }
    }
  }

  return itemResponses.length ? stringifyAnswer_(itemResponses[0].getResponse()) : "";
}

function stringifyAnswer_(answer) {
  if (Array.isArray(answer)) return answer.join(" ");
  if (answer === null || answer === undefined) return "";
  return String(answer);
}

function normalizePersonName_(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/\([^)]*재시험[^)]*\)/g, "")
    .replace(/\([^)]*재재시험[^)]*\)/g, "")
    .replace(/[0-9]+차제출/g, "")
    .trim();
}

function writeDeleteLog_(requestId, payload) {
  var safeRequestId = String(requestId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  var path = DELETE_LOG_BASE_PATH + "/" + safeRequestId;
  var response = UrlFetchApp.fetch(firebaseUrl_(path), {
    method: "put",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error("Failed to write delete log to Firebase: HTTP " + status);
  }
}

function firebaseUrl_(path) {
  var encodedPath = String(path)
    .split("/")
    .map(function(part) { return encodeURIComponent(part); })
    .join("/");
  return FIREBASE_DATABASE_URL.replace(/\/$/, "") + "/" + encodedPath + ".json";
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
