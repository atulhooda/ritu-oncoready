"""The pre-visit intake conversation OncoReady asks Ritu to run. OncoReady owns *what* is asked;
Ritu owns *how* (voice, language, turn-taking, safety). The typed simulator uses the same steps.

The questions follow standard oncology pre-visit check-ins and are tailored to the patient's
profile (cancer type, treatment status):
  - symptom check: ESAS-r items (pain, tiredness, drowsiness, nausea, appetite, breathlessness,
    depression, anxiety, wellbeing) plus a daily-activity question (the basis of ECOG status)
  - treatment side effects: common PRO-CTCAE items (fever, mouth sores, diarrhoea/constipation,
    numbness/tingling, rash, bleeding/bruising, missed doses)
  - cancer-type questions, then interval history and the patient's own priorities
Every question here is information gathering. None of it may turn into advice or interpretation.
The full list for clinical review is in docs/INTAKE_QUESTIONS.md; keep the two in step.
"""

from typing import Any

RULES = [
    "Collect information only. Never diagnose, interpret symptoms or results, or advise on treatment.",
    "Ask at most two short questions per turn. Accept a simple 'no' and move on. Never re-ask what they already told you.",
    "Use plain words, not medical terms. Keep the patient's own words for symptoms.",
    "Safety: if they report fever or chills while on chemotherapy, bleeding that will not stop, severe breathlessness, "
    "chest pain, new confusion or weakness, or thoughts of harming themselves, tell them clearly to contact their care "
    "team or emergency services now, then continue only if they want to.",
]

OPENING = {
    "id": "main_concerns",
    "goal": "Ask how they have been since their last visit and what is bothering them most right now. For each problem "
    "they raise: since when, how bad (0 to 10 if they can say), and whether it is getting better or worse.",
    "prompts": [
        "How have you been feeling since your last visit?",
        "What is bothering you the most right now?",
    ],
}

SYMPTOM_CHECK = {
    "id": "symptom_check",
    "goal": "Quickly check the common symptoms they have not already mentioned, one or two at a time: pain (where, and "
    "how bad from 0 to 10), tiredness and how much of the day they are up and about, appetite and any weight loss, "
    "nausea or vomiting, breathlessness, sleep, and mood or worry. Skip anything already covered.",
    "prompts": [
        "Do you have any pain? Where is it, and how bad is it from 0 to 10?",
        "How is your energy? Are you able to do your usual daily activities, or do you rest for much of the day?",
        "How is your appetite? Have you lost weight without trying?",
        "Any nausea or vomiting, or trouble breathing?",
        "How have you been sleeping, and how are you feeling in yourself: worried or low?",
    ],
}

TREATMENT_BY_STATUS = {
    "on_treatment": {
        "id": "treatment_side_effects",
        "goal": "Ask about their current cancer treatment in their own words: what it is, when they last had it, and "
        "whether any dose was missed or delayed. Then ask about side effects since the last treatment: fever or "
        "chills, mouth sores, loose motions or constipation, numbness or tingling in hands or feet, skin changes or "
        "rash, and unusual bleeding or bruising.",
        "prompts": [
            "What treatment are you having now, and when was your last dose or cycle?",
            "Have you missed or delayed any doses?",
            "Since your last treatment, any fever or chills, mouth sores, or loose motions?",
            "Any numbness or tingling in your hands or feet, a rash, or unusual bleeding or bruising?",
        ],
    },
    "completed": {
        "id": "after_treatment",
        "goal": "Ask what treatment they had and roughly when it finished, whether any side effects are still "
        "continuing, and whether they have noticed anything new they are worried about, such as a lump or swelling. "
        "Record it in their words; do not reassure or interpret.",
        "prompts": [
            "What treatment did you have, and when did it finish?",
            "Are any side effects still bothering you?",
            "Have you noticed anything new that worries you, like a lump or swelling?",
        ],
    },
    "not_started": {
        "id": "before_treatment",
        "goal": "Ask whether they have had any tests, scans, biopsies or appointments since the cancer was found, and "
        "whether they are waiting for any results or dates.",
        "prompts": [
            "Since the cancer was found, have you had any tests, scans or a biopsy?",
            "Are you waiting for any results or appointment dates?",
        ],
    },
    "unknown": {
        "id": "treatment",
        "goal": "Ask whether they are having any cancer treatment now (chemotherapy, radiation, surgery, tablets or "
        "injections). If yes: what, when they last had it, and any side effects such as fever, mouth sores, loose "
        "motions or tingling in hands or feet. If no: whether they are waiting for any test results or dates.",
        "prompts": [
            "Are you having any treatment for the cancer at the moment?",
            "When was your last treatment, and have you had any side effects since?",
        ],
    },
}
TREATMENT_BY_STATUS["follow_up"] = TREATMENT_BY_STATUS["completed"]

# Cancer-type questions, matched on the patient's own words for their cancer type.
CANCER_SPECIFIC: list[tuple[tuple[str, ...], dict[str, Any]]] = [
    (("breast",), {
        "id": "breast_specific",
        "goal": "Ask about any new lump or change in the breast or armpit, and swelling of the arm. If they are on a "
        "HER2 treatment (trastuzumab / Herceptin, pertuzumab): any breathlessness, ankle swelling or a racing "
        "heartbeat. If they take hormone tablets: joint pains, hot flushes, and whether they miss tablets.",
        "prompts": [
            "Have you noticed any new lump or change in your breast or armpit, or swelling of your arm?",
            "Any breathlessness, swelling of your ankles, or your heart racing?",
        ],
    }),
    (("lung",), {
        "id": "lung_specific",
        "goal": "Ask about cough (new or changed), breathlessness and what brings it on, chest pain, coughing up "
        "blood, a hoarse voice, and new headaches.",
        "prompts": [
            "How is your cough? Have you coughed up any blood?",
            "Any chest pain, a hoarse voice, or new headaches?",
        ],
    }),
    (("colon", "colorectal", "rectal", "rectum", "bowel"), {
        "id": "bowel_specific",
        "goal": "Ask about changes in bowel habit, blood in the stool, tummy pain or bloating, and stoma problems if "
        "they have a stoma.",
        "prompts": [
            "Any change in your bowel habits, or blood in your stool?",
            "Any tummy pain or bloating?",
        ],
    }),
    (("head and neck", "mouth", "oral", "throat", "tongue", "larynx", "neck"), {
        "id": "head_neck_specific",
        "goal": "Ask about pain or difficulty swallowing, mouth sores, voice changes, weight loss, and feeding-tube "
        "problems if they have one.",
        "prompts": [
            "Do you have any pain or difficulty swallowing?",
            "Any mouth sores or change in your voice?",
        ],
    }),
    (("blood", "leukaemia", "leukemia", "lymphoma", "myeloma"), {
        "id": "blood_cancer_specific",
        "goal": "Ask about fevers, night sweats, infections, unusual bruising or bleeding, new lumps in the neck, armpit "
        "or groin, and bone pain.",
        "prompts": [
            "Any fevers, night sweats or infections?",
            "Any unusual bruising or bleeding, or new lumps in your neck, armpit or groin?",
        ],
    }),
    (("cervical", "cervix", "ovarian", "ovary", "uterine", "uterus", "endometrial"), {
        "id": "gynae_specific",
        "goal": "Ask about vaginal bleeding or discharge, tummy swelling or pain, and urinary or bowel problems.",
        "prompts": [
            "Any vaginal bleeding or discharge?",
            "Any tummy swelling or pain, or problems passing urine or stool?",
        ],
    }),
    (("prostate",), {
        "id": "prostate_specific",
        "goal": "Ask about problems passing urine, bone pain, and if on hormone injections, hot flushes or tiredness.",
        "prompts": ["Any problems passing urine?", "Any pain in your bones or back?"],
    }),
    (("stomach", "gastric", "oesophag", "esophag", "pancrea", "liver"), {
        "id": "upper_gi_specific",
        "goal": "Ask about eating and swallowing, vomiting, tummy pain, yellowing of the eyes or skin, and weight loss.",
        "prompts": [
            "Any trouble eating or swallowing, or vomiting?",
            "Any tummy pain, or yellowing of your eyes or skin?",
        ],
    }),
]

SINCE_LAST_VISIT = {
    "id": "since_last_visit",
    "goal": "Ask whether since their last visit they had any hospital admission or emergency visit, started any new "
    "medicines (including over-the-counter or herbal), and whether they have any allergies.",
    "prompts": [
        "Since your last visit, have you been to a hospital or emergency department?",
        "Have you started any new medicines, including herbal or over-the-counter ones? Any allergies?",
    ],
}

PREVIOUS_RECORDS = {
    "id": "previous_records",
    "goal": "Find out which earlier records they have (reports, scans, prescriptions, discharge summaries): what, when, "
    "and from where. If they have none, that is fine: say so kindly and move on.",
    "prompts": [
        "Do you have any earlier medical records, like test reports, scans, prescriptions or discharge summaries?",
        "Which ones, and roughly when and where were they done?",
    ],
}

PRIORITIES = {
    "id": "questions_for_doctor",
    "goal": "Ask what they would most like to talk about or ask their doctor at this visit. Record it in their words.",
    "prompts": ["What would you most like to ask or discuss with your doctor at this visit?"],
}

CLOSING = (
    "Thank the patient and say their doctor will see what they shared. Only if they said they have earlier records, "
    "ask them to upload photos or PDFs of those records on the 'My records' page of their OncoReady profile. If they "
    "have no records, do not ask for any."
)
CLOSING_EXAMPLE = "Thank you. Your doctor will see what you shared today."


def cancer_specific_step(cancer_type: str | None) -> dict[str, Any] | None:
    text = (cancer_type or "").lower()
    for keywords, step in CANCER_SPECIFIC:
        if any(k in text for k in keywords):
            return step
    return None


def background(details: dict[str, Any] | None) -> str | None:
    """What the patient already told us in their profile, so Ritu does not ask it again."""
    if not details:
        return None
    parts = []
    if details.get("cancer_type"):
        parts.append(f"cancer type: {details['cancer_type']}")
    if details.get("diagnosed_on"):
        parts.append(f"found: {str(details['diagnosed_on'])[:7]}")
    if details.get("stage_reported"):
        parts.append(f"stage as told to them: {details['stage_reported']}")
    if details.get("treatment_status"):
        parts.append(f"treatment status: {details['treatment_status'].replace('_', ' ')}")
    if details.get("current_treatment"):
        parts.append(f"current treatment in their words: {details['current_treatment']}")
    if details.get("other_conditions"):
        parts.append(f"other conditions: {details['other_conditions']}")
    if not parts:
        return None
    return "Patient-reported, not verified (do not re-ask; do not interpret): " + "; ".join(parts) + "."


def build_intake_script(details: dict[str, Any] | None = None) -> dict[str, Any]:
    """The conversation for this patient: shared core, plus treatment- and cancer-type-specific steps."""
    details = details or {}
    status = details.get("treatment_status") or "unknown"
    steps = [OPENING, SYMPTOM_CHECK, TREATMENT_BY_STATUS.get(status, TREATMENT_BY_STATUS["unknown"])]
    specific = cancer_specific_step(details.get("cancer_type"))
    if specific:
        steps.append(specific)
    steps += [SINCE_LAST_VISIT, PREVIOUS_RECORDS, PRIORITIES]
    return {
        "purpose": "pre_visit_intake_oncology",
        "rules": RULES,
        "background": background(details),
        "steps": steps,
        "closing": CLOSING,
        "closing_example": CLOSING_EXAMPLE,
    }


# Default (no profile yet); kept for callers that need a script without a patient.
INTAKE_SCRIPT = build_intake_script()
