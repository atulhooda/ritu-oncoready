"""The pre-visit intake conversation OncoReady asks Ritu to run. OncoReady owns *what* is asked;
Ritu owns *how* (voice, language, turn-taking, safety). The typed simulator uses the same steps."""

INTAKE_SCRIPT = {
    "purpose": "pre_visit_intake",
    "rules": [
        "Collect information only. Never diagnose, interpret results, or advise on treatment.",
        "If the patient describes an emergency, follow Ritu's emergency protocol immediately.",
        "Use the patient's language; keep their own words for symptoms.",
    ],
    "steps": [
        {
            "id": "current_symptoms",
            "goal": "Find out every symptom the patient has now: what, since when, how severe, where, and "
            "what makes it better or worse. Keep asking 'anything else?' until they have nothing more.",
            "prompts": [
                "What problems or symptoms are you having right now?",
                "Since when has this been happening, and how bad is it?",
                "Is there anything else you are feeling that you want the doctor to know?",
            ],
        },
        {
            "id": "previous_records",
            "goal": "Find out which earlier records they have (reports, scans, prescriptions, discharge "
            "summaries): what, when, and from where. Ask them to upload these in their OncoReady profile "
            "after the conversation.",
            "prompts": [
                "Do you have any earlier medical records, like test reports, scans, prescriptions or discharge summaries?",
                "Which ones, and roughly when and where were they done?",
            ],
        },
    ],
    "closing": "Thank you. Please upload those records in your profile, and I will share this with your doctor.",
}
