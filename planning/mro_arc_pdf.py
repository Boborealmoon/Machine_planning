"""Generate Authorised Release Certificate PDFs (CAAS / FAA / EASA / JCAB / CAAC).

Layout mirrors official Form 1 / Form 8130-3 / CAAS(AW)95 on landscape A4:
header 1|2|3, org 4|5, multi-line item table 6-11 (with blank ruled slots),
remarks 12, then 13|14 with 14a release text above a 2x2 signature grid
(14b|14c over 14d|14e).

CAAS(AW)95 Issue 3: USER/INSTALLER RESPONSIBILITIES sit under the form on the
same page (form id + NOTE: + three CAAS-specific points). FAA and EASA box those
notes inside the form perimeter. EASA keeps the Block 13|14 split — New Parts
(left) is drawn then crossed out for Part-145 used-parts release.

CAAC uses AAC-038 (9/2022): bilingual Chinese/English, Conformity/Airworthiness
in Block 2, Eligibility in Block 9, remarks in Block 13, New/Used in 14|15,
shared signature Blocks 16–19, plus a full page-2 responsibilities sheet.

Unchecked / removed line items stay on the form as Quantity 0 with a blank
serial — matching common Form 1 practice across CAAS, EASA, and FAA.

Multiple selected variants are emitted as pages in a single PDF
(each page uses that authority's Block 12 correction + 14a choices).
"""
from __future__ import annotations

import io
import os
from datetime import date, datetime
from typing import Any

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ORG_NAME = "COWAY ENGINEERING & MARKETING PTE LTD"
ORG_ADDRESS = "9A Seletar Aerospace Link, Singapore 797365"
JCAB_FIXED_REMARK = "Released under the terms of the CAAS and JCAB TA-M"

# ReportLab built-ins cannot draw CJK. Prefer Adobe CID Song (STSong-Light),
# then a system Song/Ming TTF. Never use SimSun Bold — incomplete glyph coverage
# renders Chinese titles as empty □ boxes while body text still looks fine.
_CAAC_FONT = "Helvetica"
_CAAC_FONT_BOLD = "Helvetica-Bold"
_CAAC_FONTS_READY = False
_CAAC_FONT_PATH = ""


def _ensure_caac_fonts() -> None:
    """Register one complete Chinese font for all CAAC CJK text (bold = same face)."""
    global _CAAC_FONT, _CAAC_FONT_BOLD, _CAAC_FONTS_READY, _CAAC_FONT_PATH
    if _CAAC_FONTS_READY and _CAAC_FONT != "Helvetica":
        return
    _CAAC_FONTS_READY = True
    probe = "中国民用航空局批准放行证书适航批准标签使用者安装者职责"

    # 1) Built-in CID Song — reliable CJK without depending on OS bold faces
    try:
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont

        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        width = pdfmetrics.stringWidth(probe, "STSong-Light", 10)
        if width > 0:
            _CAAC_FONT = "STSong-Light"
            _CAAC_FONT_BOLD = "STSong-Light"
            _CAAC_FONT_PATH = "CID:STSong-Light"
            return
    except Exception:
        pass

    # 2) System Song / CJK faces (regular only — never simsunb)
    candidates = [
        (r"C:\Windows\Fonts\simsun.ttc", 0),
        (r"C:\Windows\Fonts\SimSun.ttc", 0),
        (r"C:\Windows\Fonts\simhei.ttf", 0),
        (r"C:\Windows\Fonts\msyh.ttc", 0),
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
        ("/usr/share/fonts/truetype/arphic/uming.ttc", 0),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
        ("/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf", 0),
    ]
    for path, subfont in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            face = "CAAC-Song"
            try:
                pdfmetrics.registerFont(TTFont(face, path, subfontIndex=subfont))
            except TypeError:
                pdfmetrics.registerFont(TTFont(face, path))
            width = pdfmetrics.stringWidth(probe, face, 10)
            if width <= 0:
                continue
            _CAAC_FONT = face
            _CAAC_FONT_BOLD = face
            _CAAC_FONT_PATH = path
            return
        except Exception:
            continue

    _CAAC_FONT = "Helvetica"
    _CAAC_FONT_BOLD = "Helvetica-Bold"
    _CAAC_FONT_PATH = ""


def _cjk_font(*, bold: bool = False) -> str:
    _ensure_caac_fonts()
    return _CAAC_FONT_BOLD if bold else _CAAC_FONT


def _pick_font(text: str, *, bold: bool = False) -> str:
    """Helvetica for Latin-only; CJK face whenever Chinese is present."""
    if text and any(_is_cjk(ch) for ch in text):
        return _cjk_font(bold=bold)
    return "Helvetica-Bold" if bold else "Helvetica"


def _cjk_centred(c: canvas.Canvas, text: str, cx: float, y: float, size: float) -> None:
    """Centre Chinese text via drawString (more reliable than drawCentredString for CJK)."""
    font = _cjk_font()
    c.setFont(font, size)
    measured = c.stringWidth(text, font, size)
    # CID/TTF stringWidth often under-reports CJK glyph advances, which shifts
    # text to the right of true centre. Blend with a glyph estimate.
    if text and any(_is_cjk(ch) for ch in text):
        estimated = sum(size * 0.95 if _is_cjk(ch) else size * 0.52 for ch in text)
        width = max(measured, (measured + estimated) / 2.0)
    else:
        width = measured
    c.drawString(cx - width / 2.0, y, text)


def _cjk_text_width(c: canvas.Canvas, text: str, size: float) -> float:
    """Width for bilingual CAAC labels (guards against under-reported CJK metrics)."""
    font = _cjk_font()
    measured = c.stringWidth(text, font, size)
    if text and any(_is_cjk(ch) for ch in text):
        estimated = sum(size * 0.95 if _is_cjk(ch) else size * 0.52 for ch in text)
        return max(measured, (measured + estimated) / 2.0)
    return measured


VARIANT_META = {
    "CAAS": {
        "authority_label": "1. Approving Civil Aviation Authority / Country",
        "authority": "CAAS/SINGAPORE",
        "title_line1": "AUTHORISED RELEASE CERTIFICATE",
        "title_line2": "FORM CAAS(AW)95",
        "tracking_prefix": "CEM / AW",
        "org_label": "4. Approved Organisation Name and Address",
        "work_label": "5. Work Order/Contract/Invoice",
        "serial_label": "10. Serial/Batch No.",
        "qty_label": "9. Quantity",
        "part_label": "8. Part No.",
        "approval_no": "AWI / 376",
        "show_org_approval": False,
        # Official CAAS(AW)95: section starts at 13a / 14a — no separate "13." / "14." titles.
        "show_part_section_titles": False,
        "block13_lead": "13a. NEW PARTS",
        "block13_heading": "Certifies that the items identified above were manufactured in conformity to:",
        "block13_options": [
            ("approved_design", "Approved design data and are in a condition for safe operation"),
            ("non_approved_block_12", "Non-approved design data specified in Block 12"),
        ],
        "sig13b": "13b. Authorised Signature",
        "sig13c": "13c. CAAS Approval No.",
        "sig13d": "13d. Name",
        "sig13e": "13e. Date (dd/mmm/yyyy)",
        "block14_heading": "14a. USED PARTS",
        "release_heading_inline": False,
        "release_options": [
            ("sar_145_50", "SAR-145.50 Release to Service"),
            ("other_block_12", "Other regulation specified in Block 12"),
        ],
        # Official CAAS(AW)95 Issue 3 used-parts statement (no "THIS IS NOT A NEW PART…" suffix).
        "release_text": (
            "Certifies that unless specified in Block 12, the work identified in Block 11 "
            "and described in Block 12, was accomplished in accordance with SAR-145 and the "
            "Air Navigation Order and in respect to that work the items are considered ready "
            "for release to service."
        ),
        "sig14b": "14b. Authorised Signature",
        "sig14c": "14c. CAAS Approval No.",
        "sig14d": "14d. Name",
        "sig14e": "14e. Date (dd/mmm/yyyy)",
        "footer_form": "CAAS(AW)95 - Issue 3",
        "footer_right": "",
        # Same-page footer under the form (official filled samples).
        "responsibilities_style": "footer_under_form",
        "responsibilities_title": "USER / INSTALLER RESPONSIBILITIES",
        "typography": "caas",
    },
    "FAA": {
        "authority_label": "1. Approving Civil Aviation Authority/Country:",
        "authority": "FAA/United States",
        "title_line1": "AUTHORIZED RELEASE CERTIFICATE",
        "title_line2": "FAA Form 8130-3, AIRWORTHINESS APPROVAL TAG",
        "tracking_prefix": "CEM/FAA",
        "org_label": "4. Organization Name and Address:",
        "work_label": "5. Work Order/Contract/Invoice Number:",
        "serial_label": "10. Serial Number:",
        "qty_label": "9. Quantity:",
        "part_label": "8. Part Number:",
        "approval_no": "8C3Y467D",
        "show_org_approval": True,
        "block13_title": "13.  NEW PARTS",
        "block13_heading": "13a.  Certifies that the items identified above were manufactured in conformity to:",
        "block13_options": [
            ("approved_design", "Approved design data and are in a condition for safe operation."),
            ("non_approved_block_12", "Non-approved design data specified in Block 12."),
        ],
        "sig13b": "13b. Authorized Signature",
        "sig13c": "13c. Approval/Authorization No.:",
        "sig13d": "13d. Name (Typed or Printed):",
        "sig13e": "13e. Date (dd/mmm/yyyy):",
        # Official FAA Form 8130-3 has no "13. NEW PARTS" / "14. USED PARTS" cell titles —
        # the section starts at 13a / 14a.
        "show_part_section_titles": False,
        "block14_title": "14.  USED PARTS",
        "block14_heading": "14a.",
        "release_options_layout": "horizontal",
        "release_options": [
            ("cfr_43_9", "14 CFR 43.9 Return to Service"),
            ("other_block_12", "Other regulation specified in Block 12"),
        ],
        "release_text": (
            "Certifies that unless otherwise specified in Block 12, the work identified in "
            "Block 11 and described in Block 12 was accomplished in accordance with Title 14, "
            "Code of Federal Regulations, part\u00a043 and in respect to that work, the items are "
            "approved for return to service."
        ),
        "sig14b": "14b. Authorized Signature:",
        "sig14c": "14c. Approval/Certificate No.:",
        "sig14d": "14d. Name (Typed or Printed):",
        "sig14e": "14e. Date (dd/mmm/yyyy):",
        "footer_form": "FAA Form 8130-3 (02-14)",
        "footer_right": "NSN: 0052-00-012-9005",
        # Boxed inside the form perimeter (not a floating CAAS-style footer / reverse page).
        "responsibilities_style": "boxed_in_form",
        "responsibilities_title": "User / Installer Responsibilities",
        "responsibilities_notes": "faa",
        # Larger type than the shared Form 1 defaults — 8130-3 print is more readable.
        "typography": "faa",
    },
    "EASA": {
        "authority_label": "1. Approving Competent Authority / Country",
        "authority": "EASA",
        "title_line1": "2. AUTHORISED RELEASE CERTIFICATE",
        "title_line2": "EASA FORM 1",
        "tracking_prefix": "CEM / EASA",
        "org_label": "4. Organisation Name and Address:",
        "work_label": "5. Work Order/Contract/Invoice",
        "serial_label": "10. Serial No.",
        "qty_label": "9. Qty.",
        "part_label": "8. Part No.",
        "approval_no": "EASA.145.0910",
        "show_org_approval": False,
        # Part-145: keep Block 13 layout, never fill it — grey + X on the left half.
        "force_used_parts": True,
        "shade_unused_block": True,
        "show_part_section_titles": False,
        "block13_title": "13.  NEW PARTS",
        "block13_heading": "13a.  Certifies that the items identified above were manufactured in conformity to:",
        "block13_options": [
            ("approved_design", "Approved design data and are in a condition for safe operation"),
            ("non_approved_block_12", "Non-approved design data specified in Block 12"),
        ],
        "sig13b": "13b. Authorised Signature",
        "sig13c": "13c. Approval/Authorisation Number",
        "sig13d": "13d. Name",
        "sig13e": "13e. Date (dd mmm yyyy)",
        "block14_title": "14.  USED PARTS",
        "block14_heading": "14a.",
        "release_options_layout": "horizontal",
        "release_options": [
            ("part_145_a_50", "Part-145.A.50 Release to Service"),
            ("other_block_12", "Other regulation specified in Block 12"),
        ],
        "release_text": (
            "Certifies that unless otherwise specified in Block 12, the work identified in "
            "Block 11 and described in Block 12, was accomplished in accordance with Part-145 "
            "and in respect to that work the items are considered ready for release to service."
        ),
        "sig14b": "14b. Authorised Signature",
        "sig14c": "14c. Certificate/Approval Ref. No.",
        "sig14d": "14d. Name",
        "sig14e": "14e. Date (dd mmm yyyy)",
        "footer_form": "EASA Form 1 - MF/CAO/145 Issue 3",
        "footer_right": "",
        # Boxed inside the form perimeter; title left-aligned like official Issue 3 samples.
        "responsibilities_style": "boxed_in_form",
        "responsibilities_title": "USER/INSTALLER RESPONSIBILITIES",
        "responsibilities_title_align": "left",
        "responsibilities_notes": "easa",
        "typography": "easa",
    },
    "JCAB": {
        # Same CAAS(AW)95 layout/wording; only Block 1 authority + tracking serial differ.
        "authority_label": "1. Approving Civil Aviation Authority / Country",
        "authority": "JCAB/JAPAN",
        "title_line1": "AUTHORISED RELEASE CERTIFICATE",
        "title_line2": "FORM CAAS(AW)95",
        "tracking_prefix": "CEM / JCAB",
        "org_label": "4. Approved Organisation Name and Address",
        "work_label": "5. Work Order/Contract/Invoice",
        "serial_label": "10. Serial/Batch No.",
        "qty_label": "9. Quantity",
        "part_label": "8. Part No.",
        "approval_no": "AWI / 376",
        "show_org_approval": False,
        "show_part_section_titles": False,
        "block13_lead": "13a. NEW PARTS",
        "block13_heading": "Certifies that the items identified above were manufactured in conformity to:",
        "block13_options": [
            ("approved_design", "Approved design data and are in a condition for safe operation"),
            ("non_approved_block_12", "Non-approved design data specified in Block 12"),
        ],
        "sig13b": "13b. Authorised Signature",
        "sig13c": "13c. CAAS Approval No.",
        "sig13d": "13d. Name",
        "sig13e": "13e. Date (dd/mmm/yyyy)",
        "block14_heading": "14a. USED PARTS",
        "release_heading_inline": False,
        "release_options": [
            ("sar_145_50", "SAR-145.50 Release to Service"),
            ("other_block_12", "Other regulation specified in Block 12"),
        ],
        "release_text": (
            "Certifies that unless specified in Block 12, the work identified in Block 11 "
            "and described in Block 12, was accomplished in accordance with SAR-145 and the "
            "Air Navigation Order and in respect to that work the items are considered ready "
            "for release to service."
        ),
        "sig14b": "14b. Authorised Signature",
        "sig14c": "14c. CAAS Approval No.",
        "sig14d": "14d. Name",
        "sig14e": "14e. Date (dd/mmm/yyyy)",
        "footer_form": "CAAS(AW)95 - Issue 3",
        "footer_right": "",
        "responsibilities_style": "footer_under_form",
        "responsibilities_title": "USER / INSTALLER RESPONSIBILITIES",
        "typography": "caas",
    },
    "CAAC": {
        "authority_label": "1 国家 Country",
        "authority": "CHINA",
        "title_line1": "批准放行证书/适航批准标签",
        "title_line2": "AUTHORIZED RELEASE CERTIFICATE/AIRWORTHINESS APPROVAL TAG",
        "title_authority": "2. 中国民用航空局 CAAC",
        "tracking_prefix": "CEM / CAAC",
        "org_label": "4 单位和地址 Organization Name and Address",
        "work_label": "5 工作单/合同单/货单 Work Order/Contract/Invoice",
        "serial_label": "11 系列号/批号 Serial/Batch No.",
        "qty_label": "10 数量 Qty",
        "part_label": "8 件号 Part No.",
        "eligibility_label": "9 适用性 Eligibility *",
        "approval_no": "F06500911",
        "show_org_approval": False,
        "block13_title": "13 备注 Remarks",
        "block14_title": "14 新产品 New Parts",
        "block15_title": "15 使用过的产品 Used Parts",
        "block14_text_zh": (
            "兹声明上述产品除第13项的其它规定以外，已按照上述国家适航条例进行制造/检查，并且"
            "该产品（出口产品）符合经批准的型号设计资料和进口国提出的专用要求。"
        ),
        "block14_text_en": (
            "Certifies that the Part(s) identified above except as otherwise specified in "
            "block 13 was(were) manufactured/inspected in accordance with the airworthiness "
            "regulations of the stated country and/or in the case of parts to be exported "
            "with the approved design data and with the notified special requirements of "
            "the importing country."
        ),
        "block15_text_zh": (
            "兹声明上述产品除第13项的其它规定以外，已按照上述国家适航条例和进口国通知的"
            "特殊要求进行了工作，该产品处于安全可用状态可以批准放行使用。"
        ),
        "block15_text_en": (
            "Certifies that the work specified above except as specified in block 13 "
            "was carried out in accordance with the airworthiness regulations of the "
            "stated country and the notified special requirements of the importing "
            "country and in respect to that work, the part(s) is (are) in condition "
            "for safe operation and considered ready for release to service."
        ),
        # Kept for shared modal wiring (used-parts panel); CAAC PDF uses block 14/15 paragraphs.
        "block13_title_legacy": "13.  NEW PARTS",
        "block13_heading": "13a.  Certifies that the items identified above were manufactured in conformity to:",
        "block13_options": [
            ("approved_design", "Approved design data and are in a condition for safe operation"),
            ("non_approved_block_12", "Non-approved design data specified in Block 12"),
        ],
        "sig13b": "13b. Authorised Signature",
        "sig13c": "13c. Approval/Authorisation Number",
        "sig13d": "13d. Name",
        "sig13e": "13e. Date (dd/mmm/yyyy)",
        "block14_heading": "14a.",
        "release_options": [
            ("caac_145_rts", "CAAC Part-145 Release to Service"),
            ("other_block_12", "Other regulation specified in Block 13 (CAAC)"),
        ],
        "release_text": (
            "Certifies that unless otherwise specified in Block 13, the work identified in "
            "Block 12 and described in Block 13 was accomplished in accordance with the "
            "applicable CAAC requirements and in respect to that work the items are considered "
            "ready for release to service."
        ),
        "sig14b": "14b. Authorised Signature",
        "sig14c": "14c. CAAC Approval No.",
        "sig14d": "14d. Name",
        "sig14e": "14e. Date (dd/mmm/yyyy)",
        "sig16": "16 批准人签名 Signature",
        "sig17": "17 批准人姓名（打印的） Name(Printed)",
        "sig18": "18 批准日期 Date",
        "sig19": "19 中国民用航空局授权 Issued by or on behalf of the CAAC",
        "footer_form": "AAC-038 (9/2022)",
        "footer_right": "*参阅产品目录详细查找适用性 Cross-check eligibility for more details with parts catalogue",
        "responsibilities_title": "使用者/安装者职责 USER/INSTALLER RESPONSIBILITIES",
    },
}

CAAC_ELIGIBILITY_OPTIONS = (
    "NOT KNOWN",
)

CAAC_USER_RESPONSIBILITIES_ZH = [
    "必须明确：本文件并不批准零件/组件/部件可以安装在有关产品上。",
    "当使用者/安装者使用的是所在国适航当局的条例，而不是本表第1项中所指国家适航当局的条例时，"
    "使用者/安装者必须保证所在国的适航当局能接受所指国家适航当局批准出口的零件/组件/部件。",
    "表中第14项、第15项的陈述，并不说明本表是安装批准。在所有情况下，航空器使用前，"
    "航空器使用者/安装者应把按本国适航条例颁发的安装批准放入维修记录中。",
]

CAAC_USER_RESPONSIBILITIES_EN = [
    "It is important to understand that the existence of this document alone does not "
    "automatically constitute authority to install the part/component/assembly.",
    "Where the user/installer works in accordance with the national regulations of an "
    "Airworthiness Authority different than the Airworthiness Authority of the country "
    "specified in block 1 it is essential that the user/installer ensure that his/her "
    "Airworthiness Authority accepts parts/components/assemblies from the Airworthiness "
    "Authority of the country specified in block 1.",
    "Statements 14 and 15 do not constitute installation certification. In all cases the "
    "aircraft maintenance record must contain an installation certification issued in "
    "accordance with the national regulation by the user/installer before the aircraft "
    "may be flown.",
]

# Configure fixed Block 12 ARC Correction wording per certificate.
# Fields start empty in the UI; operators click "Insert template" to fill these in.
ARC_CORRECTION_TEMPLATES = {
    "CAAS": (
        "THIS CERTIFICATE CORRECTS THE ERROR(S) IN BLOCK(S) _______ OF THE CERTIFICATE "
        "_______ DATED _______ AND DOES NOT COVER CONFORMITY/CONDITION/RELEASE TO SERVICE."
    ),
    "FAA": (
        "THIS FAA FORM 8130-3 CORRECTS THE ERROR(S) IN BLOCK(S) _______ OF THE FAA FORM 8130-3 "
        "_______ DATED _______ AND DOES NOT COVER CONFORMITY/CONDITION/RELEASE TO SERVICE."
    ),
    "EASA": (
        "THIS CERTIFICATE CORRECTS THE ERROR(S) IN BLOCK(S) _______ OF THE CERTIFICATE "
        "_______ DATED _______ AND DOES NOT COVER CONFORMITY/CONDITION/RELEASE TO SERVICE"
    ),
    "JCAB": (
        "THIS CERTIFICATE CORRECTS THE ERROR(S) IN BLOCK(S) _______ OF THE CERTIFICATE "
        "_______ DATED _______ AND DOES NOT COVER CONFORMITY/CONDITION/RELEASE TO SERVICE."
    ),
    "CAAC": (
        "THIS CERTIFICATE CORRECTS THE ERROR(S) IN BLOCK(S) 13 OF THE CERTIFICATE "
        "CEM/CAAC-1097 DATED _______ AND DOES NOT COVER CONFORMITY/CONDITION/RELEASE TO SERVICE.\n\n"
        "FURTHER MAINTENANCE/ TEST MIGHT BE REQUIRED.\n"
        "FOR DETAILS OF INSPECTION, REFER TO NON-DESTRUCTIVE TEST REPORT, _______"
    ),
}

USER_RESPONSIBILITIES = [
    "1. It is important to understand that the existence of this document alone does not automatically "
    "constitute authority to install the aircraft part/component/assembly.",
    "2. Where the user/installer performs work in accordance with the national regulations of an "
    "airworthiness authority different than the airworthiness authority of the country specified in "
    "Block 1, it is essential that the user/installer ensures that his/her airworthiness authority "
    "accepts parts/components/assemblies from the airworthiness authority of the country specified in Block 1.",
    "3. Statements 13a and 14a do not constitute installation certification. In all cases the "
    "aircraft maintenance record must contain an installation certification issued in accordance "
    "with the national regulations by the user/installer before the aircraft may be flown.",
]

# EASA Form 1 Issue 3 — boxed USER/INSTALLER RESPONSIBILITIES (official wording).
EASA_USER_RESPONSIBILITIES = [
    "This certificate does not automatically constitute authority to install the item(s).",
    "Where the user/installer performs work in accordance with regulations of an airworthiness "
    "authority different than the airworthiness authority specified in block 1, it is essential "
    "that the user/installer ensures that his/her airworthiness authority accepts items from the "
    "airworthiness authority specified in block 1.",
    "Statements in blocks 13a and 14a do not constitute installation certification. In all cases "
    "aircraft maintenance records must contain an installation certification issued in accordance "
    "with the national regulations by the user/installer before the aircraft may be flown.",
]

# CAAS Form CAAS(AW)95 — same-page USER / INSTALLER RESPONSIBILITIES (Issue 3).
CAAS_USER_RESPONSIBILITIES = [
    "1. It is important to understand that the existence of the Certificate alone does not "
    "automatically constitute authority to install the part/component/assembly.",
    "2. Where the user/installer works in accordance with the national regulations of an "
    "Airworthiness Authority different from the Civil Aviation Authority of Singapore (CAAS), "
    "it is essential that the user/installer ensures that his/her Airworthiness Authority "
    "accepts parts/components/assemblies from the CAAS.",
    "3. Statements 13a and 14a do not constitute installation certification. In all cases, the "
    "aircraft maintenance record must contain an installation certification issued in accordance "
    "with the national regulations by the user/installer before the aircraft may be flown.",
]

# FAA Form 8130-3 — boxed User / Installer Responsibilities (official wording).
# Third sentence starts on its own paragraph (break before "Statements in Blocks 13a and 14a").
FAA_USER_RESPONSIBILITIES = [
    "It is important to understand that the existence of this document alone does not "
    "automatically constitute authority to install the aircraft engine/propeller/article.",
    "Where the user/installer performs work in accordance with the national regulations of an "
    "airworthiness authority different than the airworthiness authority of the country specified "
    "in Block 1, it is essential that the user/installer ensures that his/her airworthiness "
    "authority accepts aircraft engine(s)/propeller(s)/article(s) from the airworthiness authority "
    "of the country specified in Block 1.",
    "Statements in Blocks 13a and 14a do not constitute installation certification. In all cases, "
    "aircraft maintenance records must contain an installation certification issued in accordance "
    "with the national regulations by the user/installer before the aircraft may be flown.",
]

# Shared Form 1 defaults vs FAA Form 8130-3 (larger, more legible print).
_TYPO_DEFAULT: dict[str, float] = {
    "label": 5.2,
    "col_label": 5.0,
    "value": 9.5,
    "title1": 11.0,
    "title2": 8.0,
    "tracking": 8.2,
    "org_name": 7.6,
    "org_addr": 6.6,
    "org_approval": 6.0,
    "block5": 8.5,
    "item": 8.0,
    "remarks": 6.8,
    "remarks_leading": 8.4,
    "remarks_label": 5.5,
    "block13_heading": 4.6,
    "block13_heading_leading": 5.6,
    "checkbox": 5.2,
    "release_heading": 5.4,
    "release_text": 5.0,
    "release_leading": 6.2,
    "section_title": 5.6,
    "sig_label": 5.0,
    "sig_value": 7.5,
    "sig_label_band": 22.0,
    "resp_title": 7.2,
    "resp_body": 5.0,
    "resp_leading": 6.2,
    "footer": 5.4,
    "h1_mm": 12.0,
    "h45_mm": 11.0,
    "h1314_mm": 56.0,
    "sig_h_mm": 22.0,
    "resp_h_mm": 32.0,
}

_TYPO_FAA: dict[str, float] = {
    **_TYPO_DEFAULT,
    "label": 7.4,
    "col_label": 7.0,
    "value": 11.0,
    "title1": 13.5,
    "title2": 9.4,
    "tracking": 10.0,
    "org_name": 9.0,
    "org_addr": 7.8,
    "org_approval": 7.4,
    "block5": 10.0,
    "item": 9.6,
    "remarks": 8.4,
    "remarks_leading": 10.2,
    "remarks_label": 7.2,
    "block13_heading": 6.8,
    "block13_heading_leading": 8.2,
    "checkbox": 7.2,
    "release_heading": 7.2,
    "release_text": 7.4,
    "release_leading": 9.0,
    "section_title": 7.2,
    "sig_label": 6.4,
    "sig_value": 8.8,
    "sig_label_band": 26.0,
    "resp_title": 9.5,
    "resp_body": 8.2,
    "resp_leading": 10.0,
    "footer": 7.0,
    "h1_mm": 14.0,
    "h45_mm": 13.0,
    "h1314_mm": 68.0,
    "sig_h_mm": 25.0,
    "resp_h_mm": 40.0,
}

_TYPO_CAAS: dict[str, float] = {
    **_TYPO_DEFAULT,
    "block13_heading": 5.4,
    "block13_heading_leading": 6.6,
    "checkbox": 5.6,
    "release_heading": 5.8,
    "release_text": 5.4,
    "release_leading": 6.6,
    "section_title": 6.0,
    "resp_title": 9.0,
    "resp_body": 7.2,
    "resp_leading": 9.0,
    "resp_note": 7.4,
    "footer": 6.0,
    "footer_reserve_mm": 46.0,
    "h1314_mm": 60.0,
}

# EASA Form 1 — boxed responsibilities (official unnumbered points).
_TYPO_EASA: dict[str, float] = {
    **_TYPO_DEFAULT,
    "resp_title": 7.2,
    "resp_body": 5.4,
    "resp_leading": 6.6,
    "resp_h_mm": 34.0,
    "h1314_mm": 58.0,
}


def _typography(meta: dict[str, Any]) -> dict[str, float]:
    key = str(meta.get("typography") or "default").strip().lower()
    if key == "faa":
        return dict(_TYPO_FAA)
    if key == "caas":
        return dict(_TYPO_CAAS)
    if key == "easa":
        return dict(_TYPO_EASA)
    return dict(_TYPO_DEFAULT)


def _responsibilities_notes(meta: dict[str, Any]) -> list[str]:
    key = str(meta.get("responsibilities_notes") or "").strip().lower()
    if key == "faa":
        return FAA_USER_RESPONSIBILITIES
    if key == "caas":
        return CAAS_USER_RESPONSIBILITIES
    if key == "easa":
        return EASA_USER_RESPONSIBILITIES
    return USER_RESPONSIBILITIES


def _text(value: Any, fallback: str = "") -> str:
    if value is None:
        return fallback
    text = str(value).strip()
    return text if text else fallback


def _format_date(value: Any) -> str:
    if not value:
        return date.today().strftime("%d/%b/%Y")
    if isinstance(value, datetime):
        return value.strftime("%d/%b/%Y")
    if isinstance(value, date):
        return value.strftime("%d/%b/%Y")
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text[:10], fmt).strftime("%d/%b/%Y")
        except ValueError:
            continue
    return text


def _is_cjk(ch: str) -> bool:
    return "\u4e00" <= ch <= "\u9fff"


def _tokenize_for_wrap(text: str) -> list[str]:
    """Split text into wrappable tokens (words + individual CJK characters)."""
    raw = (text or "").replace("\r", "")
    if not raw:
        return []
    if not any(_is_cjk(ch) for ch in raw):
        return raw.split()
    words: list[str] = []
    buf = ""
    for ch in raw:
        if ch.isspace():
            if buf:
                words.append(buf)
                buf = ""
            continue
        if _is_cjk(ch):
            if buf:
                words.append(buf)
                buf = ""
            words.append(ch)
        else:
            buf += ch
    if buf:
        words.append(buf)
    return words


def _wrap(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    max_width: float,
    font: str,
    size: float,
    leading: float | None = None,
    max_lines: int | None = None,
) -> float:
    leading = leading or (size + 1.6)
    c.setFont(font, size)
    words = _tokenize_for_wrap(text)
    if not words:
        return y
    lines: list[str] = []
    line = words[0]
    for word in words[1:]:
        joiner = "" if (line and (_is_cjk(line[-1]) or _is_cjk(word[0]))) else " "
        trial = f"{line}{joiner}{word}"
        if c.stringWidth(trial, font, size) <= max_width:
            line = trial
        else:
            lines.append(line)
            line = word
    lines.append(line)
    if max_lines is not None and len(lines) > max_lines:
        lines = lines[:max_lines]
        if len(lines[-1]) > 3:
            lines[-1] = lines[-1][:-3].rstrip() + "..."
    for drawn in lines:
        c.drawString(x, y, drawn)
        y -= leading
    return y


def _wrap_centered(
    c: canvas.Canvas,
    text: str,
    cx: float,
    y: float,
    max_width: float,
    font: str,
    size: float,
    leading: float | None = None,
    max_lines: int | None = None,
) -> float:
    """Wrap text and centre each resulting line around ``cx``."""
    leading = leading or (size + 1.6)
    c.setFont(font, size)
    words = _tokenize_for_wrap(text)
    if not words:
        return y
    lines: list[str] = []
    line = words[0]
    for word in words[1:]:
        joiner = "" if (line and (_is_cjk(line[-1]) or _is_cjk(word[0]))) else " "
        trial = f"{line}{joiner}{word}"
        if c.stringWidth(trial, font, size) <= max_width:
            line = trial
        else:
            lines.append(line)
            line = word
    lines.append(line)
    if max_lines is not None and len(lines) > max_lines:
        lines = lines[:max_lines]
        if len(lines[-1]) > 3:
            lines[-1] = lines[-1][:-3].rstrip() + "..."
    for drawn in lines:
        c.drawCentredString(cx, y, drawn)
        y -= leading
    return y


def _wrap_paragraphs(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    max_width: float,
    font: str,
    size: float,
    leading: float | None = None,
) -> float:
    leading = leading or (size + 1.8)
    for paragraph in (text or "").split("\n"):
        if not paragraph.strip():
            y -= leading * 0.55
            continue
        y = _wrap(c, paragraph.strip(), x, y, max_width, font, size, leading)
        y -= 1.2
    return y


def _wrap_paragraphs_bottom(
    c: canvas.Canvas,
    text: str,
    x: float,
    bottom_y: float,
    max_width: float,
    font: str,
    size: float,
    leading: float,
) -> None:
    """Wrap paragraphs with the final rendered line anchored at ``bottom_y``."""
    paragraphs: list[list[str]] = []
    c.setFont(font, size)
    for paragraph in (text or "").splitlines():
        words = _tokenize_for_wrap(paragraph.strip())
        if not words:
            continue
        lines: list[str] = []
        line = words[0]
        for word in words[1:]:
            joiner = "" if (line and (_is_cjk(line[-1]) or _is_cjk(word[0]))) else " "
            trial = f"{line}{joiner}{word}"
            if c.stringWidth(trial, font, size) <= max_width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
        paragraphs.append(lines)

    if not paragraphs:
        return

    paragraph_gap = 4.0
    line_count = sum(len(lines) for lines in paragraphs)
    y = bottom_y + (line_count - 1) * leading + (len(paragraphs) - 1) * paragraph_gap
    for paragraph_index, lines in enumerate(paragraphs):
        for line in lines:
            c.drawString(x, y, line)
            y -= leading
        if paragraph_index < len(paragraphs) - 1:
            y -= paragraph_gap


def _box(c: canvas.Canvas, x: float, y: float, w: float, h: float, lw: float = 0.9) -> None:
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(lw)
    c.rect(x, y, w, h, stroke=1, fill=0)


def _hline(c: canvas.Canvas, x1: float, x2: float, y: float, lw: float = 0.7) -> None:
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(lw)
    c.line(x1, y, x2, y)


def _vline(c: canvas.Canvas, x: float, y1: float, y2: float, lw: float = 0.7) -> None:
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(lw)
    c.line(x, y1, x, y2)


def _label(c: canvas.Canvas, text: str, x: float, top: float, size: float = 6.0) -> None:
    font = _pick_font(text, bold=False)
    c.setFont(font, size)
    c.drawString(x, top - size - 1.8, text)


def _label_centered(c: canvas.Canvas, text: str, cx: float, top: float, size: float = 6.0) -> None:
    font = _pick_font(text, bold=False)
    c.setFont(font, size)
    c.drawCentredString(cx, top - size - 1.8, text)


def _caac_label(c: canvas.Canvas, text: str, x: float, top: float, size: float = 7.4) -> None:
    """CAAC field labels — larger + size-aware baseline for bilingual readability."""
    font = _pick_font(text, bold=False)
    c.setFont(font, size)
    c.drawString(x, top - size - 1.8, text)


def _value(c: canvas.Canvas, text: str, x: float, y: float, size: float = 9.5) -> None:
    font = _pick_font(text or "", bold=True)
    c.setFont(font, size)
    c.drawString(x, y, text)


def _value_centered(c: canvas.Canvas, text: str, cx: float, y: float, size: float = 9.5) -> None:
    font = _pick_font(text or "", bold=True)
    c.setFont(font, size)
    c.drawCentredString(cx, y, text)


def _draw_x(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    c.setStrokeColorRGB(0.05, 0.05, 0.05)
    c.setLineWidth(1.8)
    inset = 3.5
    c.line(x + inset, y + inset, x + w - inset, y + h - inset)
    c.line(x + inset, y + h - inset, x + w - inset, y + inset)
    c.setLineWidth(0.9)


def _shade_rect(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    """Light grey fill for unused Block 13/14 (EASA Form 1 practice)."""
    c.setFillColorRGB(0.86, 0.86, 0.87)
    c.rect(x, y, w, h, stroke=0, fill=1)
    c.setFillColorRGB(0, 0, 0)


def _checkbox(
    c: canvas.Canvas,
    x: float,
    y: float,
    checked: bool,
    label: str,
    label_size: float = 7.0,
    *,
    bilingual: bool = False,
) -> None:
    size = 7.5
    c.setLineWidth(0.8)
    c.rect(x, y, size, size, stroke=1, fill=0)
    if checked:
        c.setFont("Helvetica-Bold", 8)
        c.drawString(x + 1.1, y + 0.8, "X")
    if bilingual or any(_is_cjk(ch) for ch in label):
        c.setFont(_cjk_font(), label_size)
    else:
        c.setFont("Helvetica", label_size)
    c.drawString(x + size + 3.5, y + 0.8, label)


def _caac_certificate_type(payload: dict[str, Any]) -> str:
    """Return 'conformity' or 'airworthiness' (default airworthiness)."""
    value = _text(payload.get("caac_certificate_type"), "airworthiness").lower()
    return "conformity" if value == "conformity" else "airworthiness"


def _caac_eligibility(payload: dict[str, Any], item: dict[str, Any] | None = None) -> str:
    if item:
        explicit = _text(item.get("eligibility"))
        if explicit:
            return explicit.upper()
    value = _text(payload.get("eligibility") or payload.get("caac_eligibility"), "NOT KNOWN")
    return value.upper() if value else "NOT KNOWN"


def build_remarks(payload: dict[str, Any], variant: str) -> str:
    """Build Block 12 body text for one authority page.

    The form already draws a single "12. Remarks" header. Workscope and
    Supplementary Document are written as the raw entered text. Authority-
    specific ARC Correction text (if any) is appended after a blank line.
    """
    parts: list[str] = []
    workscope = _text(payload.get("workscope"))
    supplementary = _text(payload.get("supplementary"))
    corrections = payload.get("corrections") or {}
    if not isinstance(corrections, dict):
        corrections = {}
    correction = _text(corrections.get(variant) or corrections.get(variant.lower()))
    if workscope:
        parts.append(workscope)
    if supplementary:
        parts.append(supplementary)
    if correction:
        parts.append(correction)
    return "\n\n".join(parts)


def _doc_running_number(doc_no: str) -> str | None:
    """Extract trailing running number (e.g. DUMMY-EASA-01337 → 01337)."""
    text = (doc_no or "").strip()
    if not text:
        return None
    for sep in ("-", "/", "_", " "):
        if sep in text:
            tail = text.rsplit(sep, 1)[-1].strip()
            if tail.isdigit():
                return tail
    digits = "".join(ch for ch in text if ch.isdigit())
    return digits or None


def _tracking_number(payload: dict[str, Any], variant: str) -> str:
    """Form tracking no. as ``CEM / AW - 8347`` (prefix + running number)."""
    meta = VARIANT_META[variant]
    prefix = meta["tracking_prefix"]
    doc_nos = payload.get("doc_nos") if isinstance(payload.get("doc_nos"), dict) else {}
    explicit = _text(doc_nos.get(variant)) or _text(payload.get("tracking_number"))
    number = _doc_running_number(explicit) if explicit else None
    # Preview has no allocated serial yet — keep a fixed-width placeholder.
    if not number:
        number = "00000"
    elif number.isdigit():
        n = int(number)
        # FAA filled samples commonly show 4-digit padded tracking (e.g. 0001).
        number = f"{n:04d}" if variant == "FAA" else str(n)
    return f"{prefix} - {number}"


def _item_is_removed(item: dict[str, Any]) -> bool:
    """True when the line was unchecked / marked removed for Form 1 release."""
    if item.get("removed") is True:
        return True
    if item.get("included") is False:
        return True
    return False


def _item_quantity_text(item: dict[str, Any]) -> str:
    if _item_is_removed(item):
        return "0"
    return _text(item.get("quantity"), "")


def _item_serial_text(item: dict[str, Any]) -> str:
    """Blank serial for removed / qty-0 lines; N/A only when a positive qty lacks SN."""
    if _item_is_removed(item):
        return ""
    serial = _text(item.get("serial_no"), "")
    if serial:
        return serial
    qty_text = _item_quantity_text(item)
    try:
        qty_val = int(str(qty_text).replace(",", "").strip() or "0")
    except ValueError:
        qty_val = 0
    if qty_val <= 0:
        return ""
    return "N/A"


def _normalize_payload_item(item: dict[str, Any], index: int) -> dict[str, Any]:
    """Normalize one blocks 6-11 row (removed lines → qty 0, blank serial)."""
    out = dict(item)
    removed = _item_is_removed(out)
    out["iter"] = _text(out.get("iter"), str(index + 1))
    out["description"] = _text(out.get("description"), "")
    out["part_no"] = _text(out.get("part_no"), "")
    if removed:
        out["removed"] = True
        out["included"] = False
        out["quantity"] = "0"
        out["serial_no"] = ""
    else:
        out["removed"] = False
        out["included"] = True
        out["quantity"] = _text(out.get("quantity"), "")
        out["serial_no"] = _text(out.get("serial_no"), "")
    return out


def _payload_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Return item rows for blocks 6-11 (multi-item / removal aware)."""
    raw = payload.get("items")
    if isinstance(raw, list) and raw:
        items = [
            _normalize_payload_item(dict(item), idx)
            for idx, item in enumerate(raw)
            if isinstance(item, dict)
        ]
        if items:
            return items
    item = payload.get("item")
    if isinstance(item, dict):
        return [_normalize_payload_item(dict(item), 0)]
    return [{}]


def _item_status_work(payload: dict[str, Any], item: dict[str, Any], variant: str) -> str:
    return _text(
        item.get("status_work")
        or (payload.get("status_work") or {}).get(variant)
        or item.get("status_work"),
        "",
    ).upper()


def _draw_item_cell_value(
    c: canvas.Canvas,
    value: str,
    cx: float,
    cw: float,
    row_bottom: float,
    h_row: float,
    *,
    align: str,
    font_size: float,
) -> None:
    """Draw one blocks 6-11 cell value (left for description, center otherwise)."""
    max_w = cw - 5
    c.setFont("Helvetica-Bold", font_size)
    if value and c.stringWidth(value, "Helvetica-Bold", font_size) > max_w:
        wrap_size = max(5.8, font_size - 1.0)
        wrap_y = row_bottom + h_row - 10
        wrap_leading = max(6.6, font_size)
        if align == "left":
            _wrap(
                c,
                value,
                cx + 2.5,
                wrap_y,
                max_w,
                "Helvetica-Bold",
                wrap_size,
                wrap_leading,
                max_lines=2,
            )
        else:
            _wrap_centered(
                c,
                value,
                cx + cw / 2,
                wrap_y,
                max_w,
                "Helvetica-Bold",
                wrap_size,
                wrap_leading,
                max_lines=2,
            )
        return
    baseline = row_bottom + (h_row * 0.28)
    if align == "left":
        _value(c, value, cx + 2.5, baseline, font_size)
    else:
        _value_centered(c, value, cx + cw / 2, baseline, font_size)


def _part_type(payload: dict[str, Any]) -> str:
    value = _text(payload.get("part_type"), "used").lower()
    return "new" if value == "new" else "used"


def _option_checked(selected: Any, option_value: str, default_first: str) -> bool:
    if not selected:
        return option_value == default_first
    if isinstance(selected, str):
        selected = [selected]
    return option_value in selected


def _used_checked(payload: dict[str, Any], variant: str, option_value: str, default_first: str) -> bool:
    selected = (payload.get("used_parts") or {}).get(variant) or []
    return _option_checked(selected, option_value, default_first)


def _new_checked(payload: dict[str, Any], option_value: str, default_first: str) -> bool:
    selected = payload.get("new_parts") or []
    return _option_checked(selected, option_value, default_first)


def _signature_image_reader(payload: dict[str, Any]) -> ImageReader | None:
    raw = payload.get("signature_image")
    if raw is None:
        return None
    try:
        if isinstance(raw, str):
            import base64

            text = raw.strip()
            if not text:
                return None
            if "," in text and text.lower().startswith("data:"):
                text = text.split(",", 1)[1]
            data = base64.b64decode(text)
        elif isinstance(raw, (bytes, bytearray, memoryview)):
            data = bytes(raw)
        else:
            return None
        if not data:
            return None
        return ImageReader(io.BytesIO(data))
    except Exception:
        return None


def _draw_signature_image(
    c: canvas.Canvas,
    image: ImageReader,
    x: float,
    y: float,
    w: float,
    h: float,
) -> None:
    """Fit signature image inside a content box, preserving aspect ratio."""
    try:
        iw, ih = image.getSize()
    except Exception:
        return
    if not iw or not ih:
        return
    pad_x = 3.0
    pad_y = 1.5
    avail_w = max(8.0, w - pad_x * 2)
    avail_h = max(8.0, h - pad_y * 2)
    scale = min(avail_w / float(iw), avail_h / float(ih))
    draw_w = float(iw) * scale
    draw_h = float(ih) * scale
    draw_x = x + (w - draw_w) / 2
    draw_y = y + pad_y + (avail_h - draw_h) / 2
    c.drawImage(image, draw_x, draw_y, width=draw_w, height=draw_h, mask="auto")


def _draw_sig_grid(
    c: canvas.Canvas,
    x: float,
    y: float,
    w: float,
    h: float,
    labels: tuple[str, str, str, str],
    values: tuple[str, str, str, str],
    signature_image: ImageReader | None = None,
    *,
    label_size: float = 5.0,
    value_size: float = 7.5,
    label_band: float = 22.0,
) -> None:
    """2x2 signature grid: 14b|14c over 14d|14e (same for block 13).

    Each cell keeps a reserved top label band; remarks/values are drawn only
    in the remaining lower area so long labels (e.g. Date) never collide.
    """
    mid_x = x + w / 2
    mid_y = y + h / 2
    _box(c, x, y, w, h, lw=0.8)
    _vline(c, mid_x, y, y + h, lw=0.7)
    _hline(c, x, x + w, mid_y, lw=0.7)

    # Official Form 1 order: top-left b, top-right c, bottom-left d, bottom-right e
    cells = [
        (x, mid_y, w / 2, h / 2, labels[0], values[0], True),  # b — signature
        (mid_x, mid_y, w / 2, h / 2, labels[1], values[1], False),  # c
        (x, y, w / 2, h / 2, labels[2], values[2], False),  # d
        (mid_x, y, w / 2, h / 2, labels[3], values[3], False),  # e
    ]
    for cx, cy, cw, ch, label, value, is_sig_cell in cells:
        label_pad_x = 2.5
        label_max_w = cw - label_pad_x * 2
        first_label_y = cy + ch - (label_size + 1.2)
        _wrap(
            c,
            label,
            cx + label_pad_x,
            first_label_y,
            label_max_w,
            "Helvetica",
            label_size,
            label_size + 1.2,
            max_lines=2,
        )
        content_top = cy + ch - label_band
        content_bottom = cy + 2.5
        content_h = max(6.0, content_top - content_bottom)

        if is_sig_cell and signature_image is not None:
            _draw_signature_image(
                c,
                signature_image,
                cx,
                content_bottom,
                cw,
                content_h,
            )
        elif value:
            max_w = cw - 6.0
            size = value_size
            c.setFont("Helvetica-Bold", size)
            while size > 6.0 and c.stringWidth(value, "Helvetica-Bold", size) > max_w:
                size -= 0.4
                c.setFont("Helvetica-Bold", size)
            # Centre value in the lower content band (official Form 1 / CAAS samples).
            value_y = content_bottom + max(1.0, (content_h - size) * 0.35)
            _value_centered(c, value, cx + cw / 2, value_y, size)


def draw_caas_footer(
    c: canvas.Canvas,
    *,
    x0: float,
    width: float,
    form_bottom: float,
    margin_bottom: float,
    meta: dict[str, Any],
    typo: dict[str, float] | None = None,
) -> None:
    """CAAS(AW)95 same-page footer: form id, then USER / INSTALLER RESPONSIBILITIES."""
    typo = typo or _typography(meta)
    resp_title = typo.get("resp_title", 9.0)
    resp_body = typo.get("resp_body", 7.2)
    resp_leading = typo.get("resp_leading", 9.0)
    resp_note = typo.get("resp_note", 7.4)
    footer_size = typo.get("footer", 6.0)

    band_bottom = margin_bottom + 3.0
    band_top = form_bottom - 4.0

    content_bottom = band_bottom + footer_size + 5.0
    y = band_top
    c.setFont("Helvetica", footer_size)
    c.drawString(x0, y - footer_size, meta["footer_form"])
    if meta.get("footer_right"):
        c.drawRightString(x0 + width, y - footer_size, meta["footer_right"])
    y -= footer_size + 5.0
    c.setFont("Helvetica-Bold", resp_title)
    c.drawString(x0, y - resp_title, meta.get("responsibilities_title") or "USER / INSTALLER RESPONSIBILITIES")
    y -= resp_title + 6.0
    c.setFont("Helvetica-Bold", resp_note)
    c.drawString(x0, y, "NOTE:")
    y -= resp_body + 2.0

    for note in CAAS_USER_RESPONSIBILITIES:
        y = _wrap(c, note, x0, y, width, "Helvetica", resp_body, resp_leading)
        y -= 4.0
        if y < content_bottom:
            break


def draw_caac_responsibilities_page(c: canvas.Canvas) -> None:
    """Page 2 of AAC-038 — bilingual USER/INSTALLER RESPONSIBILITIES."""
    cjk = _cjk_font()
    if cjk == "Helvetica":
        raise RuntimeError(
            "CAAC PDF requires a Chinese font (STSong-Light / SimSun). "
            "None was found — Chinese text cannot be drawn."
        )
    page_w, page_h = landscape(A4)
    margin_x = 18 * mm
    y = page_h - 22 * mm
    cx = page_w / 2

    _cjk_centred(c, "批准放行证书/适航批准标签", cx, y, 12)
    y -= 16
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(cx, y, "AUTHORIZED RELEASE CERTIFICATE/AIRWORTHINESS APPROVAL TAG")
    y -= 22
    _cjk_centred(c, "使用者/安装者职责", cx, y, 11)
    y -= 14
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(cx, y, "USER/INSTALLER RESPONSIBILITIES")
    y -= 28

    max_w = page_w - 2 * margin_x
    for idx, note in enumerate(CAAC_USER_RESPONSIBILITIES_ZH, start=1):
        y = _wrap(
            c,
            f"（{idx}）{note}",
            margin_x,
            y,
            max_w,
            cjk,
            9.0,
            12.0,
        )
        y -= 10

    y -= 10
    for idx, note in enumerate(CAAC_USER_RESPONSIBILITIES_EN, start=1):
        y = _wrap(
            c,
            f"({idx}) {note}",
            margin_x,
            y,
            max_w,
            "Helvetica",
            9.0,
            11.5,
        )
        y -= 10

    c.setFont("Helvetica", 7)
    c.drawString(margin_x, 10 * mm, "AAC-038 (9/2022)")
    c.showPage()


def draw_caac_arc_page(c: canvas.Canvas, payload: dict[str, Any]) -> None:
    """Draw CAAC AAC-038 page 1, then the responsibilities page."""
    cjk = _cjk_font()
    if cjk == "Helvetica":
        raise RuntimeError(
            "CAAC PDF requires a Chinese system font (SimSun / YaHei / Noto CJK). "
            "None was found — Chinese text cannot be drawn."
        )
    meta = VARIANT_META["CAAC"]
    page_w, page_h = landscape(A4)
    margin_x = 7 * mm
    margin_top = 5 * mm
    margin_bottom = 8 * mm
    width = page_w - 2 * margin_x
    x0 = margin_x
    y_top = page_h - margin_top

    # Leave a clear strip under the form for AAC-038 / eligibility footnotes.
    form_bottom = margin_bottom + 10 * mm
    form_height = y_top - form_bottom
    _box(c, x0, form_bottom, width, form_height, lw=1.5)

    cert_type = _caac_certificate_type(payload)
    is_new = _part_type(payload) == "new"
    signature_image = _signature_image_reader(payload)
    staff_name = _text(payload.get("certifying_staff"), "")
    cert_date = _format_date(payload.get("cert_date"))

    # ── Row 1: blocks 1 | 2 | 3 ─────────────────────────────────────────
    # Official AAC-038 Block 2 order:
    #   top:  "2. 中国民用航空局 CAAC" + Conformity/Airworthiness checkboxes
    #   mid:  批准放行证书/适航批准标签
    #   bot:  AUTHORIZED RELEASE CERTIFICATE/AIRWORTHINESS APPROVAL TAG
    h1 = 22 * mm
    w1 = width * 0.14
    w3 = width * 0.24
    w2 = width - w1 - w3
    y = y_top - h1
    _box(c, x0, y, w1, h1)
    _box(c, x0 + w1, y, w2, h1)
    _box(c, x0 + w1 + w2, y, w3, h1)

    _caac_label(c, meta["authority_label"], x0 + 2.5, y + h1, 7.4)
    _value_centered(c, meta["authority"], x0 + w1 / 2, y + h1 * 0.35, 13)

    # Block 2: centre authority + checkbox row, then titles under it
    block2_x = x0 + w1
    block2_cx = block2_x + w2 / 2
    top_row_y = y + h1 - 13.5
    cjk = _cjk_font()
    if cjk == "Helvetica":
        raise RuntimeError(
            "CAAC PDF requires a Chinese system font (SimSun / YaHei / Noto CJK). "
            "None was found — Chinese text cannot be drawn."
        )
    auth_size = 9.0
    label_size = 8.0
    box_size = 7.5
    label1 = "符合性 Conformity"
    label2 = "适航性 Airworthiness"
    auth_w = _cjk_text_width(c, meta["title_authority"], auth_size)
    label1_w = _cjk_text_width(c, label1, label_size)
    label2_w = _cjk_text_width(c, label2, label_size)
    gap_auth = 10
    gap_mid = 14
    group_w = (
        auth_w
        + gap_auth
        + box_size + 3.5 + label1_w
        + gap_mid
        + box_size + 3.5 + label2_w
    )
    group_x = block2_cx - group_w / 2
    # Keep the group inside Block 2 with a small inset
    group_x = max(block2_x + 3, min(group_x, block2_x + w2 - group_w - 3))

    c.setFont(cjk, auth_size)
    c.drawString(group_x, top_row_y, meta["title_authority"])
    check1_x = group_x + auth_w + gap_auth
    check2_x = check1_x + box_size + 3.5 + label1_w + gap_mid
    _checkbox(
        c,
        check1_x,
        top_row_y - 1.0,
        cert_type == "conformity",
        label1,
        label_size=label_size,
        bilingual=True,
    )
    _checkbox(
        c,
        check2_x,
        top_row_y - 1.0,
        cert_type == "airworthiness",
        label2,
        label_size=label_size,
        bilingual=True,
    )

    # Titles centred in Block 2
    _cjk_centred(c, meta["title_line1"], block2_cx, y + h1 * 0.40, 11.5)
    c.setFont("Helvetica-Bold", 9.0)
    c.drawCentredString(block2_cx, y + 5.5, meta["title_line2"])

    _caac_label(c, "3 证书编号 Certificate Ref. No.", x0 + w1 + w2 + 2.5, y + h1, 7.4)
    _value(c, _tracking_number(payload, "CAAC"), x0 + w1 + w2 + 3, y + h1 * 0.35, 9.0)

    # ── Row 2: blocks 4 | 5 ─────────────────────────────────────────────
    h45 = 12.5 * mm
    y -= h45
    w4 = width * 0.72
    w5 = width - w4
    _box(c, x0, y, w4, h45)
    _box(c, x0 + w4, y, w5, h45)

    _caac_label(c, meta["org_label"], x0 + 2.5, y + h45, 7.4)
    _value(c, ORG_NAME, x0 + 3, y + 16.0, 8.0)
    c.setFont("Helvetica", 7.4)
    c.drawString(x0 + 3, y + 5.5, ORG_ADDRESS)

    _caac_label(c, meta["work_label"], x0 + w4 + 2.5, y + h45, 7.2)
    po = _text(payload.get("customer_po_no"))
    block5 = f"PO: {po}" if po else _text(payload.get("sales_order_no"), "")
    _value(c, block5, x0 + w4 + 3, y + 4.5, 8.6)

    # ── Row 3: item columns 6-12 (Eligibility is Block 9) ────────────────
    cols = [
        ("6 序号 Item", 0.05, "center"),
        ("7 内容 Description", 0.20, "left"),
        (meta["part_label"], 0.12, "center"),
        (meta["eligibility_label"], 0.14, "center"),
        (meta["qty_label"], 0.07, "center"),
        (meta["serial_label"], 0.16, "center"),
        ("12 产品状态 Status/Work", 0.16, "center"),
    ]
    total_frac = sum(f for _, f, _ in cols)
    cols = [(label, frac / total_frac, align) for label, frac, align in cols]

    items = _payload_items(payload)[:10]
    if not items:
        items = [{}]
    # Only draw rows for selected item lines — no blank pad slots.
    slot_count = max(1, len(items))
    h_header = 8.2 * mm
    h_row = 9.0 * mm if slot_count <= 2 else (7.2 * mm if slot_count <= 4 else 6.4 * mm)
    h_item_block = h_header + (h_row * slot_count)
    y -= h_item_block

    cx = x0
    for label, frac, _align in cols:
        cw = width * frac
        _box(c, cx, y + h_item_block - h_header, cw, h_header)
        _caac_label(c, label, cx + 1.5, y + h_item_block, 7.4)
        cx += cw

    font_size = 7.2 if slot_count <= 2 else 6.6
    eligibility = _caac_eligibility(payload)
    for idx in range(slot_count):
        row_top = y + h_item_block - h_header - (idx * h_row)
        row_bottom = row_top - h_row
        item = items[idx] if idx < len(items) else None
        if item is None:
            values = ["", "", "", "", "", "", ""]
        else:
            values = [
                _text(item.get("iter"), str(idx + 1)),
                _text(item.get("description"), "").upper(),
                _text(item.get("part_no"), ""),
                eligibility if not _item_is_removed(item) else "",
                _item_quantity_text(item),
                _item_serial_text(item),
                _item_status_work(payload, item, "CAAC"),
            ]
        cx = x0
        for (_label_text, frac, align), value in zip(cols, values):
            cw = width * frac
            _box(c, cx, row_bottom, cw, h_row)
            if value:
                _draw_item_cell_value(
                    c,
                    value,
                    cx,
                    cw,
                    row_bottom,
                    h_row,
                    align=align,
                    font_size=font_size,
                )
            cx += cw

    # ── Row 4: remarks block 13 ─────────────────────────────────────────
    # Signature band: 16|18 over 17, with tall Block 19 on the right.
    h_sig = 22 * mm
    h1415 = 42 * mm
    h13 = max(16 * mm, y - form_bottom - h1415 - h_sig)
    y -= h13
    _box(c, x0, y, width, h13)
    _caac_label(c, meta["block13_title"], x0 + 2.5, y + h13, 7.6)
    remarks = build_remarks(payload, "CAAC")
    _wrap_paragraphs(
        c,
        remarks or "",
        x0 + 3.5,
        y + h13 - 22,
        width - 8,
        "Helvetica",
        6.6,
        8.2,
    )

    # ── Row 5: blocks 14 | 15 ───────────────────────────────────────────
    y -= h1415
    half = width / 2
    left_x = x0
    right_x = x0 + half
    _box(c, left_x, y, half, h1415)
    _box(c, right_x, y, half, h1415)

    if not is_new:
        _draw_x(c, left_x, y, half, h1415)
    if is_new:
        _draw_x(c, right_x, y, half, h1415)

    _caac_label(c, meta["block14_title"], left_x + 2.5, y + h1415, 7.6)
    text_y = y + h1415 - 20
    text_y = _wrap(
        c,
        meta["block14_text_zh"],
        left_x + 3.5,
        text_y,
        half - 8,
        cjk,
        7.2,
        9.0,
        max_lines=5,
    )
    _wrap(
        c,
        meta["block14_text_en"],
        left_x + 3.5,
        text_y - 2,
        half - 8,
        "Helvetica",
        6.6,
        8.0,
        max_lines=7,
    )

    _caac_label(c, meta["block15_title"], right_x + 2.5, y + h1415, 7.6)
    text_y = y + h1415 - 20
    text_y = _wrap(
        c,
        meta["block15_text_zh"],
        right_x + 3.5,
        text_y,
        half - 8,
        cjk,
        7.2,
        9.0,
        max_lines=5,
    )
    _wrap(
        c,
        meta["block15_text_en"],
        right_x + 3.5,
        text_y - 2,
        half - 8,
        "Helvetica",
        6.6,
        8.0,
        max_lines=7,
    )

    # ── Row 6: blocks 16|18 / 17 + tall 19 (official AAC-038 layout) ────
    # ┌──────────────┬──────────┬────────────────────┐
    # │ 16 Signature │ 18 Date  │ 19 CAAC auth        │
    # ├──────────────┴──────────┤ Certificate No …   │
    # │ 17 Name (Printed)       │                    │
    # └─────────────────────────┴────────────────────┘
    y -= h_sig
    w19 = width * 0.30
    w_left = width - w19
    w16 = w_left * 0.58
    w18 = w_left - w16
    h_top = h_sig * 0.52
    h_bot = h_sig - h_top
    mid_y = y + h_bot

    # Outer boxes
    _box(c, x0, y, w_left, h_sig)
    _box(c, x0 + w_left, y, w19, h_sig)
    # Inner split: 16 | 18 on top row, 17 full-width under them
    _vline(c, x0 + w16, mid_y, y + h_sig, lw=0.7)
    _hline(c, x0, x0 + w_left, mid_y, lw=0.7)

    # 16 Signature
    _caac_label(c, meta["sig16"], x0 + 2.2, y + h_sig, 7.0)
    if signature_image is not None:
        _draw_signature_image(c, signature_image, x0 + 2, mid_y + 1.5, w16 - 4, h_top - 11)

    # 18 Date
    _caac_label(c, meta["sig18"], x0 + w16 + 2.2, y + h_sig, 7.0)
    if cert_date:
        _value(c, cert_date, x0 + w16 + 3, mid_y + 4, 7.6)

    # 17 Name (Printed) — spans under 16 + 18
    _caac_label(c, meta["sig17"], x0 + 2.2, mid_y, 7.0)
    if staff_name:
        _value(c, staff_name, x0 + 3, y + 4.5, 8.0)

    # 19 Issued by / Certificate No — full height on the right
    _caac_label(c, meta["sig19"], x0 + w_left + 2.2, y + h_sig, 6.8)
    cert_no = f"Certificate No: {meta['approval_no']}"
    c.setFont("Helvetica-Bold", 8.0)
    c.drawCentredString(x0 + w_left + w19 / 2, y + h_sig * 0.42, cert_no)

    # Footer strip under form — keep a clear gap from the outer border
    footer_y = form_bottom - 14
    c.setFont("Helvetica", 7.2)
    c.drawString(x0, footer_y, meta["footer_form"])
    c.setFont(cjk, 6.8)
    c.drawRightString(x0 + width, footer_y, meta["footer_right"])

    c.showPage()
    draw_caac_responsibilities_page(c)


def draw_arc_page(c: canvas.Canvas, payload: dict[str, Any], variant: str) -> None:
    meta = VARIANT_META[variant]
    typo = _typography(meta)
    page_w, page_h = landscape(A4)  # 297 x 210 mm — matches CAAS/FAA sample
    margin_x = 7 * mm
    margin_top = 5 * mm
    margin_bottom = 5 * mm
    width = page_w - 2 * margin_x
    x0 = margin_x
    y_top = page_h - margin_top

    resp_style = _text(meta.get("responsibilities_style"), "footer_loose")
    # FAA / EASA: responsibilities live inside the form as a bottom table cell.
    # CAAS/JCAB: same-page footer under the form (official Issue 3 samples).
    if resp_style == "boxed_in_form":
        resp_h = typo["resp_h_mm"] * mm
        form_bottom = margin_bottom + 7 * mm
        content_floor = form_bottom + resp_h
    elif resp_style == "footer_under_form":
        resp_h = 0
        footer_reserve = typo.get("footer_reserve_mm", 32.0) * mm
        form_bottom = margin_bottom + footer_reserve
        content_floor = form_bottom
    else:
        resp_h = 0
        form_bottom = margin_bottom + 28 * mm
        content_floor = form_bottom

    form_height = y_top - form_bottom
    _box(c, x0, form_bottom, width, form_height, lw=1.5)

    # ── Row 1: blocks 1 | 2 | 3 ─────────────────────────────────────────
    h1 = typo["h1_mm"] * mm
    w1 = width * 0.22
    w3 = width * 0.22
    w2 = width - w1 - w3
    y = y_top - h1
    _box(c, x0, y, w1, h1)
    _box(c, x0 + w1, y, w2, h1)
    _box(c, x0 + w1 + w2, y, w3, h1)

    if variant in {"CAAS", "FAA"}:
        _label_centered(c, meta["authority_label"], x0 + w1 / 2, y + h1, typo["label"])
    else:
        _label(c, meta["authority_label"], x0 + 2.5, y + h1, typo["label"])
    auth_y = max(y + 3.5, y + h1 - typo["label"] - typo["value"] - 2.5)
    if variant in {"CAAS", "FAA"}:
        _value_centered(c, meta["authority"], x0 + w1 / 2, auth_y, typo["value"])
    else:
        _value(c, meta["authority"], x0 + 3, auth_y, typo["value"])

    c.setFont("Helvetica-Bold", typo["title1"])
    c.drawCentredString(x0 + w1 + w2 / 2, y + h1 - typo["title1"] - 2.0, meta["title_line1"])
    c.setFont("Helvetica-Bold", typo["title2"])
    c.drawCentredString(x0 + w1 + w2 / 2, y + 4.0, meta["title_line2"])

    tracking_cx = x0 + w1 + w2 + w3 / 2
    if variant == "CAAS":
        _label(c, "3. Form Tracking Number", x0 + w1 + w2 + 2.5, y + h1, typo["label"])
    else:
        _label(c, "3. Form Tracking Number", x0 + w1 + w2 + 2.5, y + h1, typo["label"])
    if variant == "CAAS":
        content_h = h1 - typo["label"] - 3.8
        track_y = y + (content_h - typo["tracking"]) / 2 + 1.5
    else:
        track_y = max(y + 3.5, y + h1 - typo["label"] - typo["tracking"] - 2.5)
    if variant in {"CAAS", "FAA"}:
        _value_centered(c, _tracking_number(payload, variant), tracking_cx, track_y, typo["tracking"])
    else:
        _value(c, _tracking_number(payload, variant), x0 + w1 + w2 + 3, track_y, typo["tracking"])

    # ── Row 2: blocks 4 | 5 ─────────────────────────────────────────────
    h45 = typo["h45_mm"] * mm
    y -= h45
    w4 = width * 0.72
    w5 = width - w4
    _box(c, x0, y, w4, h45)
    _box(c, x0 + w4, y, w5, h45)

    _label(c, meta["org_label"], x0 + 2.5, y + h45, typo["label"])
    # Keep org name clear below the larger FAA field label.
    name_y = y + h45 - typo["label"] - typo["org_name"] - 3.5
    addr_y = max(y + 4.0, name_y - typo["org_addr"] - 2.5)
    _value(c, ORG_NAME, x0 + 3, name_y, typo["org_name"])
    c.setFont("Helvetica", typo["org_addr"])
    c.drawString(x0 + 3, addr_y, ORG_ADDRESS)
    if meta["show_org_approval"]:
        c.setFont("Helvetica", typo["org_approval"])
        c.drawRightString(x0 + w4 - 4, addr_y, f"Approval number: {meta['approval_no']}")

    _label(c, meta["work_label"], x0 + w4 + 2.5, y + h45, typo["label"])
    po = _text(payload.get("customer_po_no"))
    block5 = f"PO: {po}" if po else _text(payload.get("sales_order_no"), "")
    if variant in {"CAAS", "FAA"}:
        if variant == "CAAS":
            content_h = h45 - typo["label"] - 3.8
            block5_y = y + (content_h - typo["block5"]) / 2 + 1.5
        else:
            block5_y = y + 4.2
        _value_centered(c, block5, x0 + w4 + w5 / 2, block5_y, typo["block5"])
    else:
        _value(c, block5, x0 + w4 + 3, y + 4.2, typo["block5"])

    # ── Row 3: item columns 6-11 (Form 1 multi-line: CAAS / FAA / EASA / …) ──
    # Column fractions mirror official Form 1 / CAAS(AW)95 / 8130-3 samples.
    cols = [
        ("6. Item", 0.055, "center"),
        ("7. Description", 0.27, "center" if variant in {"CAAS", "FAA"} else "left"),
        (meta["part_label"], 0.15, "center"),
        (meta["qty_label"], 0.08, "center"),
        (meta["serial_label"], 0.185, "center"),
        ("11. Status/Work", 0.26, "center"),
    ]
    total_frac = sum(f for _, f, _ in cols)
    cols = [(label, frac / total_frac, align) for label, frac, align in cols]

    items = _payload_items(payload)[:10]
    if not items:
        items = [{}]
    # Only draw rows for selected item lines — no blank pad slots.
    slot_count = max(1, len(items))
    h_header = 5.5 * mm if typo["col_label"] <= 5.5 else 6.5 * mm
    h_row = 10.0 * mm if slot_count <= 2 else (7.5 * mm if slot_count <= 4 else 6.6 * mm)
    if typo["item"] >= 9.0 and slot_count <= 2:
        h_row = 11.0 * mm
    h_item_block = h_header + (h_row * slot_count)
    y -= h_item_block

    # Header labels (drawn once; value rows stack underneath — Form 1 style).
    cx = x0
    for label, frac, align in cols:
        cw = width * frac
        _box(c, cx, y + h_item_block - h_header, cw, h_header)
        if variant == "CAAS" and align == "center":
            _label_centered(c, label, cx + cw / 2, y + h_item_block, typo["col_label"])
        else:
            _label(c, label, cx + 2, y + h_item_block, typo["col_label"])
        cx += cw

    font_size = typo["item"] if slot_count <= 2 else max(7.0, typo["item"] - 1.0)
    for idx in range(slot_count):
        row_top = y + h_item_block - h_header - (idx * h_row)
        row_bottom = row_top - h_row
        item = items[idx] if idx < len(items) else None
        if item is None:
            values = ["", "", "", "", "", ""]
        else:
            values = [
                _text(item.get("iter"), str(idx + 1)),
                _text(item.get("description"), "").upper(),
                _text(item.get("part_no"), ""),
                _item_quantity_text(item),
                _item_serial_text(item),
                _item_status_work(payload, item, variant),
            ]
        cx = x0
        for (_label_text, frac, align), value in zip(cols, values):
            cw = width * frac
            _box(c, cx, row_bottom, cw, h_row)
            if value:
                _draw_item_cell_value(
                    c,
                    value,
                    cx,
                    cw,
                    row_bottom,
                    h_row,
                    align=align,
                    font_size=font_size,
                )
            cx += cw

    # ── Row 4: remarks block 12 ─────────────────────────────────────────
    h1314 = typo["h1314_mm"] * mm
    h12 = max(18 * mm, y - content_floor - h1314)
    y -= h12
    _box(c, x0, y, width, h12)
    _label(c, "12. Remarks", x0 + 2.5, y + h12, typo["remarks_label"])
    remarks = build_remarks(payload, variant)
    # Start remarks clearly below the "12. Remarks" label band.
    remarks_top = y + h12 - (24 if typo["remarks_label"] > 6 else 22)
    bottom_marker = "FURTHER MAINTENANCE/ TEST MIGHT BE REQUIRED."
    if variant in {"CAAS", "FAA"} and bottom_marker in remarks:
        upper_remarks, lower_remarks = remarks.split(bottom_marker, 1)
        _wrap_paragraphs(
            c,
            upper_remarks.rstrip(),
            x0 + 3.5,
            remarks_top,
            width - 8,
            "Helvetica",
            typo["remarks"],
            typo["remarks_leading"],
        )
        _wrap_paragraphs_bottom(
            c,
            f"{bottom_marker}{lower_remarks}",
            x0 + 3.5,
            y + 4.0,
            width - 8,
            "Helvetica",
            typo["remarks"],
            typo["remarks_leading"],
        )
    else:
        _wrap_paragraphs(
            c,
            remarks or "",
            x0 + 3.5,
            remarks_top,
            width - 8,
            "Helvetica",
            typo["remarks"],
            typo["remarks_leading"],
        )
    if variant == "JCAB":
        # Mandatory JCAB wording is independent of entered remarks and remains
        # anchored at the lower-left of Block 12 in regular (unbolded) type.
        c.setFont("Helvetica", typo["remarks"])
        c.drawString(x0 + 3.5, y + 4.0, JCAB_FIXED_REMARK)

    # ── Row 5: blocks 13 | 14 (half width each — same as sample) ────────
    y -= h1314
    half = width / 2
    left_x = x0
    right_x = x0 + half
    # EASA Part-145: always treat as used — draw Block 13 then cross it out.
    is_new = False if meta.get("force_used_parts") else (_part_type(payload) == "new")
    signature_image = _signature_image_reader(payload)

    _box(c, left_x, y, half, h1314)
    _box(c, right_x, y, half, h1314)

    sig_h = typo["sig_h_mm"] * mm
    top_h = h1314 - sig_h
    sig_y = y
    top_y = y + sig_h

    staff_name = _text(payload.get("certifying_staff"), "")
    cert_date = _format_date(payload.get("cert_date"))

    # Shade unused half before grid lines so borders stay crisp.
    shade_unused = bool(meta.get("shade_unused_block"))
    if not is_new and shade_unused:
        _shade_rect(c, left_x, y, half, h1314)
    if is_new and shade_unused:
        _shade_rect(c, right_x, y, half, h1314)

    _hline(c, left_x, left_x + half, top_y, lw=0.8)
    _hline(c, right_x, right_x + half, top_y, lw=0.8)

    # Strike unused half (under ink) so labels stay readable.
    if not is_new:
        _draw_x(c, left_x, y, half, h1314)
    if is_new:
        _draw_x(c, right_x, y, half, h1314)

    # --- 13 (new parts) ---
    show_titles = bool(meta.get("show_part_section_titles", True))
    block13_lead = _text(meta.get("block13_lead"))
    section_title_size = typo["section_title"]
    # Title baseline sits at (band_top - size - 1.8); content must start fully below it.
    band_top = top_y + top_h - 0.5
    title_baseline = band_top - section_title_size - 1.8
    content_start = title_baseline - typo["block13_heading"] - 4.0
    opt_step = 11.0 if typo["checkbox"] >= 6.0 else 9.5
    if block13_lead:
        _label(c, block13_lead, left_x + 2.5, band_top, section_title_size)
        heading_top = content_start
    elif show_titles:
        _label(c, meta["block13_title"], left_x + 2.5, band_top, section_title_size)
        heading_top = content_start
    else:
        heading_top = band_top - 7
    heading_y = _wrap(
        c,
        meta["block13_heading"],
        left_x + 3.5,
        heading_top,
        half - 9,
        "Helvetica",
        typo["block13_heading"],
        typo["block13_heading_leading"],
        max_lines=3,
    )
    new_options = meta["block13_options"]
    default_new = new_options[0][0]
    opt_y = heading_y - 9
    for value, label in new_options:
        checked = is_new and _new_checked(payload, value, default_new)
        _checkbox(c, left_x + 5, opt_y, checked, label, label_size=typo["checkbox"])
        opt_y -= opt_step

    _draw_sig_grid(
        c,
        left_x,
        sig_y,
        half,
        sig_h,
        (meta["sig13b"], meta["sig13c"], meta["sig13d"], meta["sig13e"]),
        (
            "",
            meta["approval_no"] if is_new else "",
            staff_name if is_new else "",
            cert_date if is_new else "",
        ),
        signature_image=signature_image if is_new else None,
        label_size=typo["sig_label"],
        value_size=typo["sig_value"],
        label_band=typo["sig_label_band"],
    )

    # --- 14 (used / return to service) ---
    # FAA: 14a inline with horizontal checkboxes. CAAS: "14a. USED PARTS" then stacked options.
    if show_titles and not _text(meta.get("block14_heading")).startswith("14a."):
        _label(c, meta["block14_title"], right_x + 2.5, band_top, section_title_size)
    used_options = meta["release_options"]
    default_first = used_options[0][0]
    heading_14a = _text(meta.get("block14_heading"), "14a.")
    heading_inline = bool(meta.get("release_heading_inline", True))
    heading_size = typo["release_heading"]
    label_size = typo["checkbox"]
    box_size = 7.5

    if heading_inline:
        opt_y = top_y + top_h - (22 if show_titles else 13)
        c.setFont("Helvetica", heading_size)
        heading_w = c.stringWidth(heading_14a, "Helvetica", heading_size)
        c.drawString(right_x + 3.5, opt_y + 1.0, heading_14a)
        check_x = right_x + 3.5 + heading_w + 10.0
    else:
        _label(c, heading_14a, right_x + 2.5, band_top, section_title_size)
        # Checkbox box is drawn from opt_y upward by box_size — keep fully under title.
        opt_y = title_baseline - box_size - 3.0
        check_x = right_x + 5

    layout = _text(meta.get("release_options_layout"), "vertical").lower()

    if layout == "horizontal" and len(used_options) >= 1:
        x = check_x
        max_x = right_x + half - 4
        for value, label in used_options:
            checked = (not is_new) and _used_checked(payload, variant, value, default_first)
            c.setFont("Helvetica", label_size)
            label_w = c.stringWidth(label, "Helvetica", label_size)
            needed = box_size + 3.5 + label_w + 12
            if x > check_x and (x + needed) > max_x:
                opt_y -= 11
                x = check_x
            _checkbox(c, x, opt_y, checked, label, label_size=label_size)
            x += needed
        opt_y -= 13
    else:
        for value, label in used_options:
            checked = (not is_new) and _used_checked(payload, variant, value, default_first)
            _checkbox(c, check_x, opt_y, checked, label, label_size=label_size)
            opt_y -= opt_step

    if not is_new:
        _wrap(
            c,
            meta["release_text"],
            right_x + 3.5,
            opt_y - 1.0,
            half - 8,
            "Helvetica",
            typo["release_text"],
            typo["release_leading"],
            max_lines=7,
        )

    _draw_sig_grid(
        c,
        right_x,
        sig_y,
        half,
        sig_h,
        (meta["sig14b"], meta["sig14c"], meta["sig14d"], meta["sig14e"]),
        (
            "",
            meta["approval_no"] if not is_new else "",
            staff_name if not is_new else "",
            cert_date if not is_new else "",
        ),
        signature_image=signature_image if not is_new else None,
        label_size=typo["sig_label"],
        value_size=typo["sig_value"],
        label_band=typo["sig_label_band"],
    )

    # ── Responsibilities / footer (authority-specific) ─────────────────
    if resp_style == "boxed_in_form":
        # FAA / EASA: bordered responsibilities cell inside the form.
        _box(c, x0, form_bottom, width, resp_h, lw=1.0)
        title = _text(meta.get("responsibilities_title"), "User / Installer Responsibilities")
        title_align = _text(meta.get("responsibilities_title_align"), "center").lower()
        c.setFont("Helvetica-Bold", typo["resp_title"])
        if title_align == "left":
            # EASA Issue 3: title flush left, no underline under the heading.
            c.drawString(x0 + 4, form_bottom + resp_h - 12, title)
            note_y = form_bottom + resp_h - 22
        else:
            c.drawCentredString(x0 + width / 2, form_bottom + resp_h - 12, title)
            _hline(c, x0 + 3, x0 + width - 3, form_bottom + resp_h - 15, lw=0.7)
            note_y = form_bottom + resp_h - 26
        for note in _responsibilities_notes(meta):
            note_y = _wrap(
                c,
                note,
                x0 + 4,
                note_y,
                width - 8,
                "Helvetica",
                typo["resp_body"],
                typo["resp_leading"],
            )
            note_y -= 3.0 if title_align == "left" else 4.0
        c.setFont("Helvetica", typo["footer"])
        c.drawString(x0, form_bottom - 9, meta["footer_form"])
        if meta["footer_right"]:
            c.drawRightString(x0 + width, form_bottom - 9, meta["footer_right"])
        c.showPage()
        return

    if resp_style == "footer_under_form":
        draw_caas_footer(
            c,
            x0=x0,
            width=width,
            form_bottom=form_bottom,
            margin_bottom=margin_bottom,
            meta=meta,
            typo=typo,
        )
        c.showPage()
        return

    footer_top = form_bottom - 2.5
    c.setFont("Helvetica-Bold", 6.6)
    c.drawCentredString(x0 + width / 2, footer_top - 8.0, meta["responsibilities_title"])
    _hline(c, x0 + width * 0.30, x0 + width * 0.70, footer_top - 9.8, lw=0.55)

    note_y = footer_top - 16.0
    for note in USER_RESPONSIBILITIES:
        note_y = _wrap(c, note, x0, note_y, width, "Helvetica", 4.4, 5.4)
        note_y -= 2.0
        if note_y < margin_bottom + 10:
            break

    c.setFont("Helvetica", 5.4)
    c.drawString(x0, margin_bottom + 1.0, meta["footer_form"])
    if meta["footer_right"]:
        c.drawRightString(x0 + width, margin_bottom + 1.0, meta["footer_right"])

    c.showPage()



def generate_arc_pdf_bytes(payload: dict[str, Any], variants: str | list[str]) -> bytes:
    """Render one or more authority forms as pages in a single PDF."""
    if isinstance(variants, str):
        variants = [variants]
    clean: list[str] = []
    for variant in variants:
        key = str(variant or "").upper().strip()
        if key in VARIANT_META and key not in clean:
            clean.append(key)
    if not clean:
        raise ValueError("Select at least one variant (CAAS, FAA, EASA, JCAB, or CAAC)")

    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=landscape(A4))
    for variant in clean:
        if variant == "CAAC":
            draw_caac_arc_page(c, payload)
        else:
            draw_arc_page(c, payload, variant)
    c.save()
    return buffer.getvalue()


def generate_arc_documents(payload: dict[str, Any], variants: list[str]) -> tuple[bytes, str, str]:
    """Return (bytes, content_type, filename). Always a single multi-page PDF."""
    clean = []
    for variant in variants:
        key = str(variant or "").upper().strip()
        if key in VARIANT_META and key not in clean:
            clean.append(key)
    if not clean:
        raise ValueError("Select at least one variant (CAAS, FAA, EASA, JCAB, or CAAC)")

    so = _text(payload.get("sales_order_no"), "ARC").replace("/", "-")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    variant_slug = "-".join(clean)
    pdf = generate_arc_pdf_bytes(payload, clean)
    return pdf, "application/pdf", f"ARC_{variant_slug}_{so}_{stamp}.pdf"
