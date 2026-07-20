import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);

const STAGING_PROJECT_REF = "vokjkogzvtohdinhxhkk";
const STAGING_SUPABASE_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
const MODEL = "gpt-5.4-mini-2026-03-17";
const FALLBACK_MODEL = null;
const REASONING_EFFORT = "none";
const PROMPT_VERSION = "phase2-requirement-extraction-v13-atomic-no-truncated-completion";
const SCHEMA_VERSION = "aido.requirement-extraction.v10";
const INPUT_MICROUSD_PER_MILLION_TOKENS = 750_000;
const CACHED_INPUT_MICROUSD_PER_MILLION_TOKENS = 75_000;
const CACHE_WRITE_MICROUSD_PER_MILLION_TOKENS = 750_000;
const OUTPUT_MICROUSD_PER_MILLION_TOKENS = 4_500_000;
const MAX_OUTPUT_TOKENS = 4_000;
const TIMEOUT_MS = 120_000;
const MAX_BLOCK_CHARS = 1_200;
const MAX_ANCHORED_TEXT_CHARS = 120_000;
const ANCHORING_VERSION = "pdftotext-structural-lists-row-aware-ocr-atomic-clauses-v7";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const ASSIGNMENT_BUCKET = "aido-assignment-files";
const INCOMPLETE_SOURCE_COVERAGE_NOTE = "Excluded because the visible source text is incomplete.";
const INCOMPLETE_SOURCE_ISSUE = "Source text is incomplete; no requirement was extracted.";
const INCOMPLETE_SOURCE_QUESTION = "Please provide the complete source text.";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parseEnvFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) value = value.slice(1, -1);
    values[name] = value;
  }
  return values;
}

async function loadEnvironment() {
  const envPath = option("--env-file");
  if (!envPath) return;
  const values = parseEnvFile(await readFile(resolve(envPath), "utf8"));
  for (const [name, value] of Object.entries(values)) {
    if (!process.env[name]) process.env[name] = value;
  }
}

function checklistHasProviderRequestApproval(checklist, projectId) {
  const approval = checklist.provider_request_approval;
  const scope = approval?.scope;
  return approval?.approved_for_provider_request === true
    && typeof approval?.reviewer === "string"
    && approval.reviewer.trim().length >= 2
    && Number.isFinite(Date.parse(approval?.reviewed_at ?? ""))
    && scope?.target_environment === "staging"
    && scope?.staging_project_ref === STAGING_PROJECT_REF
    && scope?.project_id === projectId
    && scope?.model_requested === MODEL
    && scope?.prompt_version === PROMPT_VERSION
    && scope?.schema_version === SCHEMA_VERSION
    && scope?.anchoring_version === ANCHORING_VERSION;
}

async function loadReviewChecklist(checklistPath, project, documents, repositoryRoot) {
  if (!checklistPath) return null;
  const resolvedPath = resolve(checklistPath);
  if (resolvedPath === repositoryRoot || resolvedPath.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("The human reference checklist must be stored outside the repository.");
  }
  const bytes = await readFile(resolvedPath);
  let checklist;
  try {
    checklist = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("The human reference checklist is not valid JSON.");
  }
  const expectedHashes = new Map(documents.map((document) => [document.kind, document.content_hash]));
  const checklistHashes = new Map(
    (Array.isArray(checklist.documents) ? checklist.documents : [])
      .map((document) => [document.kind, document.content_hash]),
  );
  if (
    checklist.target_environment !== "staging"
    || checklist.staging_project_ref !== STAGING_PROJECT_REF
    || checklist.project_id !== project.id
    || checklist.prompt_version !== PROMPT_VERSION
    || checklist.schema_version !== SCHEMA_VERSION
    || checklist.model_requested !== MODEL
    || checklist.anchoring_version !== ANCHORING_VERSION
    || expectedHashes.size !== checklistHashes.size
    || [...expectedHashes].some(([kind, hash]) => checklistHashes.get(kind) !== hash)
  ) throw new Error("The human reference checklist does not match this staging evaluation.");
  if (!checklistHasProviderRequestApproval(checklist, project.id)) {
    throw new Error(
      "The human reference checklist must be explicitly reviewed and approved for this exact provider request.",
    );
  }
  const approvalScope = checklist.provider_request_approval.scope;
  return {
    path: resolvedPath,
    version: checklist.checklist_version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    approved_for_provider_request: true,
    reviewed_at: checklist.provider_request_approval.reviewed_at,
    approval_scope: approvalScope,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function assertUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
}

function safeErrorCode(error) {
  if (!error) return "unknown";
  const code = typeof error.code === "string" ? error.code : undefined;
  const status = Number.isInteger(error.status) ? String(error.status) : undefined;
  return code ?? status ?? "unknown";
}

async function resolveProject(admin) {
  const requestedProjectId = option("--project-id");
  if (requestedProjectId) {
    assertUuid(requestedProjectId, "--project-id");
    const { data, error } = await admin
      .from("aido_writing_projects")
      .select("id, owner_id, status")
      .eq("id", requestedProjectId)
      .maybeSingle();
    if (error) throw new Error(`The staging project could not be read (${safeErrorCode(error)}).`);
    if (!data) throw new Error("The requested staging project does not exist.");
    return data;
  }

  const { data: projects, error } = await admin
    .from("aido_writing_projects")
    .select("id, owner_id, status, updated_at")
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Staging projects could not be read (${safeErrorCode(error)}).`);

  for (const project of projects ?? []) {
    const { data: documents, error: documentError } = await admin
      .from("aido_assignment_documents")
      .select("kind")
      .eq("project_id", project.id)
      .is("replaced_at", null);
    if (documentError) {
      throw new Error(`Staging document metadata could not be read (${safeErrorCode(documentError)}).`);
    }
    const kinds = new Set((documents ?? []).map((document) => document.kind));
    if (kinds.has("brief") && kinds.has("rubric")) return project;
  }

  throw new Error("No active staging project has both a brief and rubric.");
}

async function loadDocuments(admin, projectId) {
  const { data, error } = await admin
    .from("aido_assignment_documents")
    .select("id, kind, original_filename, storage_bucket, storage_path, mime_type, size_bytes, content_hash")
    .eq("project_id", projectId)
    .in("kind", ["brief", "rubric"])
    .is("replaced_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Staging document metadata could not be read (${safeErrorCode(error)}).`);

  const byKind = new Map();
  for (const document of data ?? []) byKind.set(document.kind, document);
  const documents = [byKind.get("brief"), byKind.get("rubric")].filter(Boolean);
  if (documents.length !== 2) throw new Error("The project must have one current brief and one current rubric.");
  if (documents.some((document) => document.storage_bucket !== ASSIGNMENT_BUCKET)) {
    throw new Error("A document points at an unexpected storage bucket.");
  }
  if (documents.some((document) => document.mime_type !== "application/pdf")) {
    throw new Error("The first quality evaluation accepts the uploaded PDF brief and rubric only.");
  }
  if (documents.reduce((sum, document) => sum + document.size_bytes, 0) > 50 * 1024 * 1024) {
    throw new Error("The combined documents exceed OpenAI's 50 MB request limit.");
  }

  const loaded = [];
  for (const document of documents) {
    const { data: blob, error: downloadError } = await admin.storage
      .from(ASSIGNMENT_BUCKET)
      .download(document.storage_path);
    if (downloadError || !blob) throw new Error("A private staging document could not be downloaded.");
    const bytes = Buffer.from(await blob.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== document.size_bytes || digest !== document.content_hash) {
      throw new Error("A staging document failed its size or content-hash check.");
    }
    loaded.push({ ...document, bytes });
  }
  return loaded;
}

function normalizedWords(text) {
  return text
    .toLocaleLowerCase("en")
    .match(/[a-z0-9]{3,}/g) ?? [];
}

function shouldIncludeOcrSupplement(pdfText, ocrText) {
  const pdfWords = normalizedWords(pdfText);
  const ocrWords = normalizedWords(ocrText);
  if (ocrWords.length < 40) return false;
  if (pdfWords.length === 0) return true;

  const pdfVocabulary = new Set(pdfWords);
  const novelWordCount = ocrWords.filter((word) => !pdfVocabulary.has(word)).length;
  return ocrWords.length >= Math.ceil(pdfWords.length * 1.25)
    && novelWordCount >= 30
    && novelWordCount / ocrWords.length >= 0.15;
}

function pngDimensions(bytes) {
  if (
    bytes.length < 24
    || bytes.toString("ascii", 1, 4) !== "PNG"
    || bytes.toString("ascii", 12, 16) !== "IHDR"
  ) throw new Error("A rendered staging PDF page was not a valid PNG.");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function criterionLabelsFromTsv(tsv, cropWidth, cropHeight) {
  const lines = new Map();
  for (const [index, rawLine] of tsv.split(/\r?\n/).entries()) {
    if (index === 0 || !rawLine) continue;
    const columns = rawLine.split("\t");
    if (columns.length < 12 || Number(columns[0]) !== 5) continue;
    const confidence = Number(columns[10]);
    const text = columns.slice(11).join("\t").trim();
    const left = Number(columns[6]);
    if (!text || confidence < 60 || left >= cropWidth * 0.82) continue;
    const key = columns.slice(1, 5).join(":");
    const existing = lines.get(key) ?? { top: Number(columns[7]), words: [] };
    existing.words.push({ left, text });
    lines.set(key, existing);
  }

  const visualLines = [...lines.values()]
    .map((line) => ({
      top: line.top,
      text: line.words.sort((a, b) => a.left - b.left).map((word) => word.text).join(" "),
    }))
    .filter((line) => /[A-Za-z]{3}/.test(line.text))
    .sort((a, b) => a.top - b.top);
  const groups = [];
  const groupGap = Math.max(40, cropHeight * 0.06);
  for (const line of visualLines) {
    const previous = groups.at(-1);
    if (!previous || line.top - previous.lastTop > groupGap) {
      groups.push({ lastTop: line.top, lines: [line.text] });
    } else {
      previous.lines.push(line.text);
      previous.lastTop = line.top;
    }
  }
  return groups
    .map((group) => group.lines.join(" ").replace(/\s+/g, " ").trim())
    .map((label) => label.replace(/^criteria\s+/i, "").trim())
    .filter((label) => !/^criteria$/i.test(label));
}

function coalesceOcrTableRows(ocrText, criterionLabels) {
  const rawBlocks = ocrText
    .replace(/\r/g, "")
    .split(/\n\s*\n+/)
    .flatMap(splitBlock);
  const mergedBlocks = [];
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const current = rawBlocks[index];
    const next = rawBlocks[index + 1];
    const reportMentions = current.match(/report/gi)?.length ?? 0;
    if (next && current.length < 250 && reportMentions >= 3 && next.length >= 100) {
      mergedBlocks.push(`${current} ${next}`.replace(/\s+/g, " ").trim());
      index += 1;
    } else {
      mergedBlocks.push(current);
    }
  }

  const headerIndex = mergedBlocks.findIndex((block) => (
    /criteria/i.test(block)
    && /excellent/i.test(block)
    && /satisfactory/i.test(block)
    && /developing/i.test(block)
  ));
  const supportIndex = mergedBlocks.findIndex((block, index) => index > headerIndex && /^support$/i.test(block));
  if (headerIndex < 0 || supportIndex < 0) {
    return mergedBlocks.map((text) => ({ text, extraction_method: "local_ocr" }));
  }

  const rowIndexes = [];
  for (let index = headerIndex + 1; index < supportIndex; index += 1) {
    if (mergedBlocks[index].length >= 140) rowIndexes.push(index);
  }
  if (!criterionLabels.length || rowIndexes.length > criterionLabels.length) {
    return mergedBlocks.map((text) => ({ text, extraction_method: "local_ocr" }));
  }

  const rowLabels = criterionLabels.slice(0, rowIndexes.length);
  const rowIndexToLabel = new Map(rowIndexes.map((rowIndex, index) => [rowIndex, rowLabels[index]]));
  return mergedBlocks.map((text, index) => {
    const label = rowIndexToLabel.get(index);
    return label
      ? {
        text: `Rubric criterion: ${label}. ${text}`,
        extraction_method: "local_ocr_table_row",
      }
      : { text, extraction_method: "local_ocr" };
  });
}

async function extractPdfPageText(documents) {
  const directory = await mkdtemp(join(tmpdir(), "aido-phase2-pdf-"));
  try {
    for (const document of documents) {
      const inputFilename = `${document.kind}.pdf`;
      const filePath = join(directory, inputFilename);
      await writeFile(filePath, document.bytes, { mode: 0o600 });
      let stdout;
      try {
        ({ stdout } = await execFileAsync(
          "pdftotext",
          ["-layout", "-enc", "UTF-8", filePath, "-"],
          { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
        ));
      } catch {
        throw new Error("A staging PDF could not be converted to page text for anchor validation.");
      }
      const pages = stdout.split("\f");
      if (pages.at(-1)?.trim() === "") pages.pop();
      if (!pages.length) throw new Error("A staging PDF did not contain any readable pages.");
      document.page_text = pages;
      document.page_ocr_supplements = [];

      for (const [pageIndex, pdfText] of pages.entries()) {
        const pageNumber = pageIndex + 1;
        const imagePrefix = `${document.kind}-ocr-p${pageNumber}`;
        try {
          await execFileAsync(
            "pdftoppm",
            [
              "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile",
              "-png", "-r", "300", inputFilename, imagePrefix,
            ],
            { cwd: directory, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
          );
          const { stdout: ocrText } = await execFileAsync(
            "tesseract",
            [`${imagePrefix}.png`, "stdout", "-l", "eng", "--psm", "6"],
            { cwd: directory, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
          );
          if (!shouldIncludeOcrSupplement(pdfText, ocrText)) {
            document.page_ocr_supplements[pageIndex] = null;
            continue;
          }

          let criterionLabels = [];
          if (document.kind === "rubric") {
            const imageBytes = await readFile(join(directory, `${imagePrefix}.png`));
            const { width, height } = pngDimensions(imageBytes);
            const crop = {
              x: Math.round(width * 0.105),
              y: Math.round(height * 0.11),
              width: Math.round(width * 0.18),
              height: Math.round(height * 0.45),
            };
            const cropPrefix = `${imagePrefix}-criteria`;
            await execFileAsync(
              "pdftoppm",
              [
                "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile",
                "-png", "-r", "300", "-x", String(crop.x), "-y", String(crop.y),
                "-W", String(crop.width), "-H", String(crop.height), inputFilename, cropPrefix,
              ],
              { cwd: directory, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
            );
            const { stdout: criterionTsv } = await execFileAsync(
              "tesseract",
              [`${cropPrefix}.png`, "stdout", "-l", "eng", "--psm", "6", "tsv"],
              { cwd: directory, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
            );
            criterionLabels = criterionLabelsFromTsv(
              criterionTsv,
              crop.width,
              crop.height,
            );
          }
          document.page_ocr_supplements[pageIndex] = { text: ocrText, criterionLabels };
        } catch {
          throw new Error("A staging PDF page could not be rendered and checked with local OCR.");
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function splitBlock(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const parts = [];
  let remaining = normalized;
  while (remaining.length > MAX_BLOCK_CHARS) {
    const boundary = remaining.lastIndexOf(" ", MAX_BLOCK_CHARS);
    const splitAt = boundary >= Math.floor(MAX_BLOCK_CHARS * 0.6) ? boundary : MAX_BLOCK_CHARS;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function splitStructuralBlocks(text) {
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n\s*\n+/);
  const blocks = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    let current = [];
    const flush = () => {
      if (!current.length) return;
      blocks.push(...splitBlock(current.join(" ")));
      current = [];
    };
    for (const line of lines) {
      const beginsListItem = /^(?:[•●▪◦*]|\d+[.)])\s+\S/u.test(line);
      if (beginsListItem) flush();
      current.push(line);
    }
    flush();
  }
  return blocks;
}

const assessedActionPattern = /\b(?:submit|write|prepare|report|select|choose|read|explain|discuss|evaluate|analyse|analyze|identify|describe|demonstrate|apply|reflect|compare|examine|investigate)\b/i;

function isCandidateStudentAction(text) {
  return (
    /(?:^|\s)\d+[.)]\s+\S/u.test(text)
    && /\b(?:you|your)\b/i.test(text)
    && assessedActionPattern.test(text)
  );
}

function structuralHint(block) {
  if (block.extraction_method === "local_ocr_table_row") return "rubric_row";
  if (isCandidateStudentAction(block.text)) return "candidate_student_action";
  return "unclassified";
}

const atomicActionVerbPattern = /\b(?:submit|write|prepare|select|choose|read|explain|discuss|evaluate|analyse|analyze|identify|describe|demonstrate|apply|reflect|reflecting|compare|examine|investigate|understand|cover|elaborate|make|include|provide)\b/gi;

function extractAtomicActionClauses(block) {
  if (block.structural_hint !== "candidate_student_action" || block.locally_incomplete_text) {
    return [];
  }
  const matches = [...block.text.matchAll(atomicActionVerbPattern)];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const sourceText = block.text
      .slice(match.index, next?.index ?? block.text.length)
      .replace(/\b(?:and|to)\s*$/i, "")
      .trim();
    return {
      id: `${block.id}-c${String(index + 1).padStart(2, "0")}`,
      anchor_id: block.id,
      source_text: sourceText,
      text_sha256: createHash("sha256").update(sourceText).digest("hex"),
    };
  }).filter((clause) => clause.source_text.length > 2);
}

function isLocallyIncompleteBlock(block) {
  const text = block.text.trim();
  if (!text) return true;
  if (/(?:\.{3}|…|[-–—])$/u.test(text)) return true;
  if (/\b(?:a|an|and|as|at|by|for|from|in|including|into|of|on|or|the|that|to|with)$/iu.test(text)) {
    return true;
  }
  return block.extraction_method === "local_ocr_table_row"
    && !/[.!?][\])}"']?$/u.test(text);
}

function atomicActionClauses(blocks) {
  return blocks.flatMap((block) => block.atomic_clauses ?? []);
}

function buildAnchoredBlocks(documents) {
  const blocks = [];
  for (const document of documents) {
    for (const [pageIndex, pageText] of document.page_text.entries()) {
      const pageBlocks = splitStructuralBlocks(pageText)
        .map((text) => ({ text, extraction_method: "pdf_text" }));
      const ocrSupplement = document.page_ocr_supplements?.[pageIndex] ?? null;
      if (ocrSupplement) {
        pageBlocks.push(...coalesceOcrTableRows(
          ocrSupplement.text,
          ocrSupplement.criterionLabels,
        ));
      }
      for (const [blockIndex, block] of pageBlocks.entries()) {
        const anchoredBlock = {
          id: `${document.kind}-p${pageIndex + 1}-b${String(blockIndex + 1).padStart(3, "0")}`,
          document_id: document.id,
          source_id: document.kind,
          filename: document.original_filename,
          page_number: pageIndex + 1,
          text: block.text,
          extraction_method: block.extraction_method,
          structural_hint: structuralHint(block),
          text_sha256: createHash("sha256").update(block.text).digest("hex"),
        };
        anchoredBlock.locally_incomplete_text = isLocallyIncompleteBlock(anchoredBlock);
        anchoredBlock.atomic_clauses = extractAtomicActionClauses(anchoredBlock);
        blocks.push(anchoredBlock);
      }
    }
  }
  if (!blocks.length) throw new Error("No anchored source blocks could be created from the staging PDFs.");
  const anchoredText = blocks.map((block) => {
    const clauseReceipt = block.atomic_clauses.length
      ? ` [atomic_action_clauses=${block.atomic_clauses.map(
        (clause) => `${clause.id}:${JSON.stringify(clause.source_text)}`,
      ).join(" | ")}]`
      : "";
    return `[${block.id}] [structural_hint=${block.structural_hint}] [locally_incomplete_text=${block.locally_incomplete_text}]${clauseReceipt} ${block.text}`;
  }).join("\n\n");
  if (anchoredText.length > MAX_ANCHORED_TEXT_CHARS) {
    throw new Error("The anchored source text exceeds the approved evaluation input limit.");
  }
  return { blocks, anchoredText };
}

const sourceAnchorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["anchor_id"],
  properties: {
    anchor_id: { type: "string" },
  },
};

function coverageRequiredBlocks(blocks) {
  return blocks.filter((block) => (
    block.extraction_method === "pdf_text"
    || block.extraction_method === "local_ocr_table_row"
  ));
}

function constrainSourceAnchorSchema(blocks) {
  sourceAnchorSchema.properties.anchor_id.enum = blocks.map((block) => block.id);
  const coverageIds = coverageRequiredBlocks(blocks).map((block) => block.id);
  extractionSchema.properties.source_coverage.required = coverageIds;
  extractionSchema.properties.source_coverage.properties = Object.fromEntries(
    coverageRequiredBlocks(blocks).map((block) => [
      block.id,
      coverageDecisionSchemaForBlock(block),
    ]),
  );
  const clauses = atomicActionClauses(blocks);
  extractionSchema.properties.atomic_clause_coverage.required = clauses.map((clause) => clause.id);
  extractionSchema.properties.atomic_clause_coverage.properties = Object.fromEntries(
    clauses.map((clause) => [clause.id, atomicClauseCoverageDecisionSchema(clause)]),
  );
}

function metadataFieldSchema(valueType) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "source_anchors"],
    properties: {
      value: { type: [valueType, "null"] },
      source_anchors: { type: "array", minItems: 0, maxItems: 4, items: sourceAnchorSchema },
    },
  };
}

const coverageDecisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "has_incomplete_text", "notes"],
  properties: {
    classification: {
      type: "string",
      enum: [
        "assignment_requirement", "assignment_metadata", "rubric_requirement",
        "integrity_policy", "ambiguity", "context_only", "unusable_or_incomplete",
      ],
    },
    has_incomplete_text: { type: "boolean" },
    notes: { type: "string", maxLength: 300 },
  },
};

function coverageDecisionSchemaForBlock(block) {
  if (!block.locally_incomplete_text) return coverageDecisionSchema;
  return {
    type: "object",
    additionalProperties: false,
    required: ["classification", "has_incomplete_text", "notes"],
    properties: {
      classification: { type: "string", enum: ["unusable_or_incomplete"] },
      has_incomplete_text: { type: "boolean", enum: [true] },
      notes: { type: "string", enum: [INCOMPLETE_SOURCE_COVERAGE_NOTE] },
    },
  };
}

function atomicClauseCoverageDecisionSchema(clause) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["requirement_id", "source_text", "source_text_sha256", "notes"],
    properties: {
      requirement_id: { type: "string", minLength: 1, maxLength: 80 },
      source_text: { type: "string", enum: [clause.source_text] },
      source_text_sha256: { type: "string", enum: [clause.text_sha256] },
      notes: { type: "string", maxLength: 300 },
    },
  };
}

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version", "source_coverage", "atomic_clause_coverage", "assignment_metadata",
    "requirements", "ambiguities", "citation_rules", "integrity_policy_signals",
    "document_warnings",
  ],
  properties: {
    schema_version: { type: "string", enum: [SCHEMA_VERSION] },
    source_coverage: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    atomic_clause_coverage: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    assignment_metadata: {
      type: "object",
      additionalProperties: false,
      required: [
        "assessment_type", "overall_weight_percent", "word_count", "citation_style",
        "file_format", "submission_destination", "deadline_text",
      ],
      properties: {
        assessment_type: metadataFieldSchema("string"),
        overall_weight_percent: metadataFieldSchema("number"),
        word_count: metadataFieldSchema("integer"),
        citation_style: metadataFieldSchema("string"),
        file_format: metadataFieldSchema("string"),
        submission_destination: metadataFieldSchema("string"),
        deadline_text: metadataFieldSchema("string"),
      },
    },
    requirements: {
      type: "array",
      minItems: 1,
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "requirement_id", "requirement", "category", "command_verbs", "deliverables", "constraints",
          "rubric_weight_percent", "source_anchors", "confidence", "needs_student_confirmation",
        ],
        properties: {
          requirement_id: { type: "string", minLength: 1, maxLength: 80 },
          requirement: { type: "string", minLength: 1, maxLength: 600 },
          category: {
            type: "string",
            enum: [
              "task", "content", "analysis", "learning_outcome", "deliverable", "format",
              "source", "citation", "policy", "rubric",
            ],
          },
          command_verbs: { type: "array", items: { type: "string" }, maxItems: 12 },
          deliverables: { type: "array", items: { type: "string" }, maxItems: 12 },
          constraints: { type: "array", items: { type: "string" }, maxItems: 30 },
          rubric_weight_percent: { type: ["number", "null"], minimum: 0, maximum: 100 },
          source_anchors: { type: "array", minItems: 1, maxItems: 8, items: sourceAnchorSchema },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          needs_student_confirmation: { type: "boolean" },
        },
      },
    },
    ambiguities: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issue", "severity", "source_anchors", "question_for_lecturer"],
        properties: {
          issue: { type: "string", maxLength: 600 },
          severity: { type: "string", enum: ["critical", "important", "minor"] },
          source_anchors: { type: "array", minItems: 1, maxItems: 8, items: sourceAnchorSchema },
          question_for_lecturer: { type: "string", maxLength: 600 },
        },
      },
    },
    citation_rules: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule", "source_anchors"],
        properties: {
          rule: { type: "string", maxLength: 600 },
          source_anchors: { type: "array", minItems: 1, maxItems: 8, items: sourceAnchorSchema },
        },
      },
    },
    integrity_policy_signals: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["signal", "source_anchors"],
        properties: {
          signal: { type: "string", maxLength: 600 },
          source_anchors: { type: "array", minItems: 1, maxItems: 8, items: sourceAnchorSchema },
        },
      },
    },
    document_warnings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["warning", "document_kind", "page_number"],
        properties: {
          warning: { type: "string", maxLength: 600 },
          document_kind: { type: "string", enum: ["brief", "rubric"] },
          page_number: { type: ["integer", "null"], minimum: 1 },
        },
      },
    },
  },
};

function extractOutputText(payload) {
  const parts = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function collectAnchors(extraction) {
  return [
    ...Object.values(extraction.assignment_metadata ?? {}).flatMap(
      (field) => Array.isArray(field?.source_anchors) ? field.source_anchors : [],
    ),
    ...extraction.requirements.flatMap((row) => row.source_anchors),
    ...extraction.ambiguities.flatMap((row) => row.source_anchors),
    ...extraction.citation_rules.flatMap((row) => row.source_anchors),
    ...extraction.integrity_policy_signals.flatMap((row) => row.source_anchors),
  ];
}

function normalizeSourceCoverageReceipt(extraction) {
  if (Array.isArray(extraction?.source_coverage)) return;
  if (
    !extraction?.source_coverage
    || typeof extraction.source_coverage !== "object"
  ) {
    extraction.source_coverage = [];
    return;
  }
  extraction.source_coverage = Object.entries(extraction.source_coverage).map(
    ([anchor_id, decision]) => ({ anchor_id, ...decision }),
  );
}

function normalizeAtomicClauseCoverageReceipt(extraction) {
  if (Array.isArray(extraction?.atomic_clause_coverage)) return;
  if (
    !extraction?.atomic_clause_coverage
    || typeof extraction.atomic_clause_coverage !== "object"
  ) {
    extraction.atomic_clause_coverage = [];
    return;
  }
  extraction.atomic_clause_coverage = Object.entries(extraction.atomic_clause_coverage).map(
    ([clause_id, decision]) => ({ clause_id, ...decision }),
  );
}

function canonicalizeNullMetadataAnchors(extraction) {
  let removed = 0;
  for (const field of Object.values(extraction?.assignment_metadata ?? {})) {
    if (field?.value !== null || !Array.isArray(field.source_anchors)) continue;
    removed += field.source_anchors.length;
    field.source_anchors = [];
  }
  return removed;
}

function canonicalizeSourceCoverage(extraction) {
  const rows = Array.isArray(extraction?.source_coverage) ? extraction.source_coverage : [];
  const canonical = [];
  const seen = new Map();
  let deduplicated = 0;
  for (const row of rows) {
    const previous = seen.get(row?.anchor_id);
    if (!previous) {
      seen.set(row?.anchor_id, row);
      canonical.push(row);
      continue;
    }
    if (
      previous.classification === row.classification
      && previous.has_incomplete_text === row.has_incomplete_text
    ) {
      deduplicated += 1;
      continue;
    }
    canonical.push(row);
  }
  extraction.source_coverage = canonical;
  return deduplicated;
}

function blockExcerpt(text) {
  return text;
}

function materializeAnchors(extraction, blocks) {
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  let materialized = 0;
  for (const anchor of collectAnchors(extraction)) {
    if (!anchor.anchor_id) continue;
    const block = blockById.get(anchor.anchor_id);
    if (!block) continue;
    Object.assign(anchor, {
      document_id: block.document_id,
      source_id: block.source_id,
      filename: block.filename,
      page_number: block.page_number,
      evidence_excerpt: blockExcerpt(block.text),
      evidence_sha256: block.text_sha256,
    });
    materialized += 1;
  }
  return materialized;
}

function normalizeEvidence(value) {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-")
    .replace(/^(?:\.{3}|…)+|(?:\.{3}|…)+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeEvidenceForMatch(value) {
  return value
    .normalize("NFKC")
    .replace(/(\p{L})-\s+(\p{L})/gu, "$1$2")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeExactSourceText(value) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function requirementSearchableParts(row) {
  return [
    row.requirement,
    ...(Array.isArray(row.command_verbs) ? row.command_verbs : []),
    ...(Array.isArray(row.deliverables) ? row.deliverables : []),
    ...(Array.isArray(row.constraints) ? row.constraints : []),
  ].filter((value) => typeof value === "string" && value.trim());
}

function evidenceAppearsOnPage(excerpt, pageText) {
  const normalizedExcerpt = normalizeEvidence(excerpt);
  const normalizedPage = normalizeEvidence(pageText);
  if (normalizedPage.includes(normalizedExcerpt)) return true;

  const searchableExcerpt = normalizeEvidenceForMatch(excerpt);
  const searchablePage = normalizeEvidenceForMatch(pageText);
  if (searchableExcerpt && searchablePage.includes(searchableExcerpt)) return true;

  const segments = excerpt
    .split(/(?:\.{3}|…)+/)
    .map(normalizeEvidenceForMatch)
    .filter((segment) => segment.split(" ").length >= 2);
  if (segments.length < 2) return false;
  let cursor = 0;
  for (const segment of segments) {
    const index = searchablePage.indexOf(segment, cursor);
    if (index < 0) return false;
    cursor = index + segment.length;
  }
  return true;
}

function bindAnchorsToKnownDocuments(extraction, documents) {
  const expectedFilenames = new Map(documents.map((document) => [document.kind, document.original_filename]));
  let canonicalizedSourceLabels = 0;
  for (const anchor of collectAnchors(extraction)) {
    const expected = expectedFilenames.get(anchor.document_kind);
    if (!anchor.document_id && expected && anchor.filename !== expected) {
      anchor.filename = expected;
      canonicalizedSourceLabels += 1;
    }
  }
  return canonicalizedSourceLabels;
}

function validateExtraction(
  extraction,
  documents,
  blocks,
  expectedSchemaVersion = SCHEMA_VERSION,
) {
  if (!extraction || extraction.schema_version !== expectedSchemaVersion || !Array.isArray(extraction.requirements)) {
    return {
      passed: false,
      anchors: 0,
      issues: {
        schema_mismatch: 1,
        source_coverage_mismatch: 0,
        source_coverage_output_mismatch: 0,
        atomic_clause_coverage_mismatch: 0,
        atomic_clause_receipt_mismatch: 0,
        atomic_clause_nonunique_requirement: 0,
        atomic_clause_requirement_mismatch: 0,
        duplicate_requirement_id: 0,
        candidate_student_action_without_requirement: 0,
        locally_incomplete_source_not_marked: 0,
        incomplete_source_classification_mismatch: 0,
        incomplete_source_coverage_note_mismatch: 0,
        incomplete_source_without_ambiguity: 0,
        incomplete_source_ambiguity_mismatch: 0,
        incomplete_source_requirement_prohibited: 0,
        incomplete_source_semantic_output_prohibited: 0,
        metadata_shape_mismatch: 0,
        metadata_anchor_mismatch: 0,
        missing_requirement_anchor: 0,
        rubric_requirement_without_row_anchor: 0,
        invalid_page: 0,
        filename_mismatch: 0,
        empty_excerpt: 0,
        excerpt_not_found_on_page: 0,
        unknown_document_id: 0,
        document_kind_mismatch: 0,
        unknown_source_id: 0,
        unknown_anchor_id: 0,
        materialized_anchor_mismatch: 0,
      },
    };
  }
  const anchors = collectAnchors(extraction);
  const metadataFields = Object.values(extraction.assignment_metadata ?? {});
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const requiredCoverageIds = coverageRequiredBlocks(blocks).map((block) => block.id);
  const coverageRows = Array.isArray(extraction.source_coverage) ? extraction.source_coverage : [];
  const coverageCounts = new Map();
  for (const row of coverageRows) {
    coverageCounts.set(row?.anchor_id, (coverageCounts.get(row?.anchor_id) ?? 0) + 1);
  }
  const coverageById = new Map(coverageRows.map((row) => [row.anchor_id, row]));
  const clauses = atomicActionClauses(blocks);
  const clauseRows = Array.isArray(extraction.atomic_clause_coverage)
    ? extraction.atomic_clause_coverage
    : [];
  const clauseCoverageCounts = new Map();
  for (const row of clauseRows) {
    clauseCoverageCounts.set(row?.clause_id, (clauseCoverageCounts.get(row?.clause_id) ?? 0) + 1);
  }
  const clauseCoverageById = new Map(clauseRows.map((row) => [row.clause_id, row]));
  const clauseRequirementCounts = new Map();
  for (const row of clauseRows) {
    clauseRequirementCounts.set(
      row?.requirement_id,
      (clauseRequirementCounts.get(row?.requirement_id) ?? 0) + 1,
    );
  }
  const requirementIdCounts = new Map();
  for (const row of extraction.requirements) {
    requirementIdCounts.set(row?.requirement_id, (requirementIdCounts.get(row?.requirement_id) ?? 0) + 1);
  }
  const requirementsById = new Map(
    extraction.requirements.map((row) => [row.requirement_id, row]),
  );
  const requirementAnchorIds = new Set(
    extraction.requirements.flatMap((row) => row.source_anchors.map((anchor) => anchor.anchor_id)),
  );
  const ambiguityAnchorIds = new Set(
    extraction.ambiguities.flatMap((row) => row.source_anchors.map((anchor) => anchor.anchor_id)),
  );
  const semanticOutputAnchorIds = [
    ...Object.values(extraction.assignment_metadata ?? {}).flatMap(
      (field) => field?.source_anchors ?? [],
    ),
    ...extraction.requirements.flatMap((row) => row.source_anchors),
    ...extraction.citation_rules.flatMap((row) => row.source_anchors),
    ...extraction.integrity_policy_signals.flatMap((row) => row.source_anchors),
  ].map((anchor) => anchor.anchor_id);
  const locallyIncompleteAnchorIds = new Set(
    blocks.filter((block) => block.locally_incomplete_text).map((block) => block.id),
  );
  const incompleteAnchorIds = new Set([
    ...coverageRows.filter((row) => row?.has_incomplete_text === true).map((row) => row.anchor_id),
    ...locallyIncompleteAnchorIds,
  ]);
  const issues = {
    schema_mismatch: 0,
    source_coverage_mismatch: (
      coverageRows.length !== requiredCoverageIds.length
      || requiredCoverageIds.some((anchorId) => coverageCounts.get(anchorId) !== 1)
      || coverageRows.some((row) => !requiredCoverageIds.includes(row?.anchor_id))
    ) ? 1 : 0,
    source_coverage_output_mismatch: requiredCoverageIds.filter((anchorId) => {
      const row = coverageById.get(anchorId);
      if (!row) return false;
      if (
        row.classification === "assignment_requirement"
        || row.classification === "rubric_requirement"
      ) return !requirementAnchorIds.has(anchorId);
      if (
        row.classification === "context_only"
        || row.classification === "unusable_or_incomplete"
      ) return requirementAnchorIds.has(anchorId);
      return false;
    }).length,
    atomic_clause_coverage_mismatch: (
      clauseRows.length !== clauses.length
      || clauses.some((clause) => clauseCoverageCounts.get(clause.id) !== 1)
      || clauseRows.some((row) => !clauses.some((clause) => clause.id === row?.clause_id))
    ) ? 1 : 0,
    atomic_clause_receipt_mismatch: clauses.filter((clause) => {
      const receipt = clauseCoverageById.get(clause.id);
      return !receipt
        || receipt.source_text !== clause.source_text
        || receipt.source_text_sha256 !== clause.text_sha256;
    }).length,
    atomic_clause_nonunique_requirement: [...clauseRequirementCounts.values()].filter(
      (count) => count !== 1,
    ).length,
    atomic_clause_requirement_mismatch: clauses.filter((clause) => {
      const receipt = clauseCoverageById.get(clause.id);
      const requirement = requirementsById.get(receipt?.requirement_id);
      if (!requirement) return true;
      if (clauseRequirementCounts.get(receipt.requirement_id) !== 1) return true;
      if (
        requirement.source_anchors.length !== 1
        || requirement.source_anchors[0]?.anchor_id !== clause.anchor_id
      ) {
        return true;
      }
      if (
        normalizeExactSourceText(requirement.requirement)
        !== normalizeExactSourceText(clause.source_text)
      ) return true;
      const visibleClause = normalizeEvidenceForMatch(clause.source_text);
      return requirementSearchableParts(requirement)
        .slice(1)
        .some((part) => !visibleClause.includes(normalizeEvidenceForMatch(part)));
    }).length,
    duplicate_requirement_id: [...requirementIdCounts.values()].filter((count) => count !== 1).length,
    candidate_student_action_without_requirement: blocks.filter((block) => (
      block.structural_hint === "candidate_student_action"
      && !requirementAnchorIds.has(block.id)
    )).length,
    locally_incomplete_source_not_marked: [...locallyIncompleteAnchorIds].filter(
      (anchorId) => coverageById.get(anchorId)?.has_incomplete_text !== true,
    ).length,
    incomplete_source_classification_mismatch: [...incompleteAnchorIds].filter(
      (anchorId) => coverageById.get(anchorId)?.classification !== "unusable_or_incomplete",
    ).length,
    incomplete_source_coverage_note_mismatch: [...incompleteAnchorIds].filter(
      (anchorId) => coverageById.get(anchorId)?.notes !== INCOMPLETE_SOURCE_COVERAGE_NOTE,
    ).length,
    incomplete_source_without_ambiguity: [...incompleteAnchorIds].filter(
      (anchorId) => !ambiguityAnchorIds.has(anchorId),
    ).length,
    incomplete_source_ambiguity_mismatch: [...incompleteAnchorIds].filter((anchorId) => {
      const rows = extraction.ambiguities.filter((row) => (
        row.source_anchors.some((anchor) => anchor.anchor_id === anchorId)
      ));
      return rows.length !== 1
        || rows[0].source_anchors.length !== 1
        || rows[0].severity !== "important"
        || rows[0].issue !== INCOMPLETE_SOURCE_ISSUE
        || rows[0].question_for_lecturer !== INCOMPLETE_SOURCE_QUESTION;
    }).length,
    incomplete_source_requirement_prohibited: extraction.requirements.filter((row) => (
      row.source_anchors.some((anchor) => incompleteAnchorIds.has(anchor.anchor_id))
    )).length,
    incomplete_source_semantic_output_prohibited: semanticOutputAnchorIds.filter(
      (anchorId) => incompleteAnchorIds.has(anchorId),
    ).length,
    metadata_shape_mismatch: metadataFields.length === 7 ? 0 : 1,
    metadata_anchor_mismatch: metadataFields.filter((field) => {
      const anchorCount = Array.isArray(field?.source_anchors) ? field.source_anchors.length : 0;
      return field?.value === null ? anchorCount !== 0 : anchorCount === 0;
    }).length,
    missing_requirement_anchor: extraction.requirements.filter(
      (row) => !Array.isArray(row.source_anchors) || row.source_anchors.length === 0,
    ).length,
    rubric_requirement_without_row_anchor: extraction.requirements.filter((row) => (
      row.category === "rubric"
      && !row.source_anchors.some((anchor) => (
        blockById.get(anchor.anchor_id)?.extraction_method === "local_ocr_table_row"
      ))
    )).length,
    invalid_page: 0,
    filename_mismatch: 0,
    empty_excerpt: 0,
    excerpt_not_found_on_page: 0,
    unknown_document_id: 0,
    document_kind_mismatch: 0,
    unknown_source_id: 0,
    unknown_anchor_id: 0,
    materialized_anchor_mismatch: 0,
  };
  for (const anchor of anchors) {
    if (anchor.anchor_id) {
      const block = blockById.get(anchor.anchor_id);
      if (!block) {
        issues.unknown_anchor_id += 1;
        continue;
      }
      if (
        anchor.document_id !== block.document_id
        || anchor.source_id !== block.source_id
        || anchor.filename !== block.filename
        || anchor.page_number !== block.page_number
        || anchor.evidence_sha256 !== block.text_sha256
        || anchor.evidence_excerpt !== blockExcerpt(block.text)
      ) issues.materialized_anchor_mismatch += 1;
      continue;
    }
    const document = anchor.source_id
      ? documents.find((candidate) => candidate.kind === anchor.source_id)
      : anchor.document_id
      ? documents.find((candidate) => candidate.id === anchor.document_id)
      : documents.find((candidate) => candidate.kind === anchor.document_kind);
    if (anchor.source_id && !document) issues.unknown_source_id += 1;
    if (anchor.document_id && !document) issues.unknown_document_id += 1;
    if (anchor.document_kind && document && document.kind !== anchor.document_kind) {
      issues.document_kind_mismatch += 1;
    }
    const pageIsValid = Number.isInteger(anchor.page_number)
      && anchor.page_number >= 1
      && anchor.page_number <= (document?.page_text?.length ?? 0);
    if (!pageIsValid) issues.invalid_page += 1;
    if (anchor.filename && (!document || document.original_filename !== anchor.filename)) {
      issues.filename_mismatch += 1;
    }
    const excerpt = typeof anchor.evidence_excerpt === "string"
      ? normalizeEvidence(anchor.evidence_excerpt)
      : "";
    if (!excerpt) {
      issues.empty_excerpt += 1;
    } else if (pageIsValid) {
      const pageText = document.page_text[anchor.page_number - 1];
      if (!evidenceAppearsOnPage(anchor.evidence_excerpt, pageText)) {
        issues.excerpt_not_found_on_page += 1;
      }
    }
  }
  return {
    passed: extraction.requirements.length > 0 && Object.values(issues).every((count) => count === 0),
    anchors: anchors.length,
    issues,
  };
}

function calculateCostMicrousd(usage) {
  const input = Number(usage?.input_tokens ?? 0);
  const cached = Number(usage?.input_tokens_details?.cached_tokens ?? 0);
  const cacheWrite = Number(usage?.input_tokens_details?.cache_write_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const uncached = Math.max(0, input - cached - cacheWrite);
  return Math.ceil((
    uncached * INPUT_MICROUSD_PER_MILLION_TOKENS
    + cached * CACHED_INPUT_MICROUSD_PER_MILLION_TOKENS
    + cacheWrite * CACHE_WRITE_MICROUSD_PER_MILLION_TOKENS
    + output * OUTPUT_MICROUSD_PER_MILLION_TOKENS
  ) / 1_000_000);
}

function publicSummaryFromReport(report) {
  return {
    completed: true,
    target_environment: report.target_environment,
    staging_project_ref: report.staging_project_ref,
    project_id: report.project_id,
    document_count: report.document_metadata.length,
    document_page_counts: Object.fromEntries(
      report.document_metadata.map((document) => [document.kind, document.page_count]),
    ),
    provider: report.provider,
    model_requested: report.model_requested,
    model_returned: report.model_returned,
    fallback_model: report.fallback_model ?? null,
    reasoning_effort: report.reasoning_effort ?? null,
    response_id: report.response_id,
    prompt_version: report.prompt_version,
    schema_version: report.schema_version,
    human_checklist_reference: report.human_checklist_reference ?? null,
    store: report.store,
    tools_enabled: report.tools_enabled,
    searches_enabled: report.searches_enabled,
    input_mode: report.input_mode ?? null,
    anchoring_version: report.anchoring_version ?? null,
    anchor_block_count: report.anchor_block_count ?? null,
    table_row_anchor_count: report.table_row_anchor_count ?? null,
    candidate_student_action_block_count:
      report.candidate_student_action_block_count ?? null,
    atomic_action_clause_count: report.atomic_action_clause_count ?? null,
    locally_incomplete_block_count: report.locally_incomplete_block_count ?? null,
    coverage_required_block_count: report.coverage_required_block_count ?? null,
    ocr_supplement_page_count: report.ocr_supplement_page_count ?? null,
    anchored_text_sha256: report.anchored_text_sha256 ?? null,
    latency_ms: report.latency_ms,
    input_tokens: report.usage.input_tokens,
    cached_input_tokens: report.usage.cached_input_tokens,
    cache_write_input_tokens: report.usage.cache_write_input_tokens ?? 0,
    output_tokens: report.usage.output_tokens,
    estimated_cost_microusd: report.usage.estimated_cost_microusd,
    automatic_validation_passed: report.automatic_validation.passed,
    automatic_validation_issues: report.automatic_validation.issues,
    requirement_count: report.automatic_validation.requirement_count,
    source_anchor_count: report.automatic_validation.source_anchor_count,
    ambiguity_count: report.automatic_validation.ambiguity_count,
    source_coverage_count: report.automatic_validation.source_coverage_count ?? null,
    deduplicated_source_coverage_count:
      report.automatic_validation.deduplicated_source_coverage_count ?? 0,
    null_metadata_anchors_removed:
      report.automatic_validation.null_metadata_anchors_removed ?? 0,
    canonicalized_source_labels: report.automatic_validation.canonicalized_source_labels,
    materialized_anchor_count: report.automatic_validation.materialized_anchor_count,
    human_review_required: report.automatic_validation.human_review_required,
  };
}

function reviewHtml(report) {
  const reviewData = {
    response_id: report.response_id,
    model: report.model_returned,
    prompt_version: report.prompt_version,
    schema_version: report.schema_version,
    automatic_validation: report.automatic_validation,
    assignment_metadata: report.extraction.assignment_metadata,
    atomic_clause_coverage: report.extraction.atomic_clause_coverage,
    requirements: report.extraction.requirements,
    ambiguities: report.extraction.ambiguities,
    citation_rules: report.extraction.citation_rules,
    integrity_policy_signals: report.extraction.integrity_policy_signals,
  };
  const encodedData = JSON.stringify(reviewData)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AidoForMe Phase 2 provider review</title>
  <style>
    :root { color-scheme: light; --ink:#171717; --muted:#686868; --line:#dedede; --soft:#f6f6f4; --blue:#174ee8; --green:#1e7147; --red:#a22929; }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); background:#fff; font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select,textarea { font:inherit; }
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:3px solid #8eb6ff; outline-offset:2px; }
    header { padding:24px 30px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:20px; align-items:center; }
    h1 { margin:0; font-size:22px; letter-spacing:-.025em; }
    header p { margin:3px 0 0; color:var(--muted); font-size:13px; }
    .status { padding:7px 11px; border:1px solid #b8dbc9; border-radius:999px; color:var(--green); background:#f4fbf7; font-size:12px; font-weight:700; white-space:nowrap; }
    main { display:grid; grid-template-columns:minmax(520px, 1.05fr) minmax(420px, .95fr); min-height:calc(100vh - 91px); }
    .review { padding:28px 30px 80px; overflow:auto; }
    .source { position:sticky; top:0; height:calc(100vh - 91px); border-left:1px solid var(--line); background:var(--soft); padding:18px; }
    .source-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
    .source-switch { display:flex; gap:8px; }
    .source-switch button,.anchor-button { border:1px solid var(--line); background:#fff; border-radius:9px; cursor:pointer; }
    .source-switch button { padding:8px 12px; }
    .source-switch button.active { color:#fff; background:var(--ink); border-color:var(--ink); }
    iframe { width:100%; height:calc(100% - 50px); border:1px solid var(--line); border-radius:12px; background:#fff; }
    .intro { margin-bottom:26px; padding:18px; border:1px solid var(--line); border-radius:14px; background:var(--soft); }
    .intro strong { display:block; margin-bottom:5px; }
    .intro p { margin:0; color:var(--muted); }
    h2 { margin:30px 0 12px; font-size:17px; }
    .requirement { margin:0 0 14px; padding:18px; border:1px solid var(--line); border-radius:14px; }
    .requirement-head { display:flex; gap:12px; align-items:flex-start; }
    .number { width:28px; height:28px; border-radius:8px; background:var(--ink); color:#fff; display:grid; place-items:center; flex:none; font-weight:700; font-size:12px; }
    .requirement h3 { margin:1px 0 4px; font-size:15px; }
    .meta { color:var(--muted); font-size:12px; }
    .anchors { margin:14px 0; display:grid; gap:8px; }
    .anchor { padding:11px; border-left:3px solid #a8bce9; background:#f7f9ff; border-radius:0 9px 9px 0; }
    .anchor-button { padding:4px 7px; margin-bottom:6px; color:var(--blue); font-size:11px; }
    blockquote { margin:0; color:#444; font-size:12px; }
    .anchor-check { display:flex; gap:8px; margin-top:8px; align-items:flex-start; font-size:12px; font-weight:600; }
    .decision { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:13px; border-top:1px solid var(--line); }
    label span { display:block; margin-bottom:5px; color:var(--muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; }
    select,input[type="text"],input[type="number"],textarea { width:100%; border:1px solid #cfcfcf; border-radius:9px; padding:9px 10px; background:#fff; }
    .critical { display:flex; gap:8px; align-items:center; padding-top:23px; }
    .critical span { display:inline; margin:0; color:var(--ink); text-transform:none; letter-spacing:0; }
    .coverage { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
    .coverage label { display:flex; gap:8px; align-items:center; padding:10px; border:1px solid var(--line); border-radius:10px; }
    .coverage label span { display:inline; margin:0; color:var(--ink); text-transform:none; letter-spacing:0; }
    .notes { min-height:90px; resize:vertical; }
    .summary { position:sticky; bottom:0; margin:28px -30px -80px; padding:18px 30px; border-top:1px solid var(--line); background:rgba(255,255,255,.96); backdrop-filter:blur(10px); display:flex; justify-content:space-between; align-items:center; gap:20px; }
    .metrics { display:flex; gap:24px; }
    .metric strong { display:block; font-size:17px; }
    .metric span { color:var(--muted); font-size:11px; }
    .export { border:0; border-radius:10px; padding:11px 16px; color:#fff; background:var(--ink); cursor:pointer; font-weight:700; }
    .export:disabled { opacity:.4; cursor:not-allowed; }
    .result { font-size:12px; font-weight:700; }
    .result.pass { color:var(--green); } .result.fail { color:var(--red); }
    @media (max-width: 980px) { main { display:block; } .source { position:relative; height:70vh; border-left:0; border-top:1px solid var(--line); } .review { padding-inline:20px; } .summary { margin-inline:-20px; padding-inline:20px; } }
  </style>
</head>
<body>
  <header>
    <div><h1>Phase 2 provider quality review</h1><p>Compare every extracted requirement with the real brief and rubric.</p></div>
    <div class="status">Automatic grounding passed</div>
  </header>
  <main>
    <section class="review">
      <div class="intro"><strong>This review controls provider approval.</strong><p>Mark a requirement correct only when it is explicit in the source. Verify each blue evidence block. Any invented requirement or unsupported anchor fails the gate.</p></div>
      <label><span>Reviewer name</span><input id="reviewer" type="text" autocomplete="name" placeholder="Your name"></label>
      <h2>Extracted requirements</h2>
      <div id="requirements"></div>
      <h2>Coverage checklist</h2>
      <p class="meta">Check each area only after confirming it is fully and correctly represented.</p>
      <div id="coverage" class="coverage"></div>
      <h2>Missing critical requirements</h2>
      <label><span>Number missing</span><input id="missing-count" type="number" min="0" value="0"></label>
      <label><span>Private reviewer notes</span><textarea id="notes" class="notes" placeholder="Describe anything missing or incorrect. These notes are included only in your downloaded review file."></textarea></label>
      <div class="summary">
        <div class="metrics">
          <div class="metric"><strong id="recall">—</strong><span>Critical recall</span></div>
          <div class="metric"><strong id="accuracy">0%</strong><span>Anchor accuracy</span></div>
          <div><div id="result" class="result fail">Review incomplete</div><span class="meta">Pass requires ≥95% for both, no invented/partial rows, and complete coverage.</span></div>
        </div>
        <button id="export" class="export" disabled>Download review JSON</button>
      </div>
    </section>
    <aside class="source">
      <div class="source-toolbar"><strong>Source document</strong><div class="source-switch"><button data-file="brief.pdf" class="active">Brief</button><button data-file="rubric.pdf">Rubric</button></div></div>
      <iframe id="pdf" title="Source PDF" src="brief.pdf#page=1"></iframe>
    </aside>
  </main>
  <script id="review-data" type="application/json">${encodedData}</script>
  <script>
    const data = JSON.parse(document.getElementById('review-data').textContent);
    const coverageAreas = ['Command verbs','Deliverables','Constraints and formatting','Rubric weights','Word count','Citation rules','Integrity-policy signals','Ambiguities'];
    const stateKey = 'aido-phase2-review-' + data.response_id;
    const saved = JSON.parse(localStorage.getItem(stateKey) || '{}');
    const state = { reviewer:'', missing_count:0, notes:'', requirements:{}, coverage:{}, ...saved };
    const byId = id => document.getElementById(id);
    const sourceFile = sourceId => sourceId === 'rubric' ? 'rubric.pdf' : 'brief.pdf';
    function openSource(anchor) {
      const file = sourceFile(anchor.source_id);
      byId('pdf').src = file + '#page=' + anchor.page_number;
      document.querySelectorAll('.source-switch button').forEach(button => button.classList.toggle('active', button.dataset.file === file));
    }
    document.querySelectorAll('.source-switch button').forEach(button => button.addEventListener('click', () => {
      byId('pdf').src = button.dataset.file + '#page=1';
      document.querySelectorAll('.source-switch button').forEach(item => item.classList.toggle('active', item === button));
    }));
    function create(tag, className, text) { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; }
    data.requirements.forEach((row, index) => {
      const key=String(index); const current=state.requirements[key] || { verdict:'unreviewed', critical:false, anchors:row.source_anchors.map(() => false) }; state.requirements[key]=current;
      const card=create('article','requirement'); const head=create('div','requirement-head'); head.append(create('div','number',String(index+1)));
      const copy=create('div'); copy.append(create('h3','',row.requirement)); copy.append(create('div','meta',row.category+' · confidence '+row.confidence+(row.rubric_weight_percent===null?'':' · weight '+row.rubric_weight_percent+'%'))); head.append(copy); card.append(head);
      const anchors=create('div','anchors'); row.source_anchors.forEach((anchor, anchorIndex) => {
        const box=create('div','anchor'); const jump=create('button','anchor-button',anchor.anchor_id+' · '+anchor.source_id+' page '+anchor.page_number); jump.type='button'; jump.addEventListener('click',()=>openSource(anchor)); box.append(jump); box.append(create('blockquote','',anchor.evidence_excerpt));
        const label=create('label','anchor-check'); const check=document.createElement('input'); check.type='checkbox'; check.checked=Boolean(current.anchors[anchorIndex]); check.addEventListener('change',()=>{current.anchors[anchorIndex]=check.checked; saveAndScore();}); label.append(check,create('span','', 'This exact block supports the requirement')); box.append(label); anchors.append(box);
      }); card.append(anchors);
      const decision=create('div','decision'); const verdictLabel=create('label'); verdictLabel.append(create('span','', 'Requirement verdict')); const select=document.createElement('select'); [['unreviewed','Select…'],['correct','Correct and explicit'],['partial','Partly correct'],['invented','Invented / unsupported']].forEach(([value,label])=>{const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}); select.value=current.verdict; select.addEventListener('change',()=>{current.verdict=select.value;saveAndScore();}); verdictLabel.append(select); decision.append(verdictLabel);
      const criticalLabel=create('label','critical'); const critical=document.createElement('input'); critical.type='checkbox'; critical.checked=Boolean(current.critical); critical.addEventListener('change',()=>{current.critical=critical.checked;saveAndScore();}); criticalLabel.append(critical,create('span','', 'Critical requirement')); decision.append(criticalLabel); card.append(decision); byId('requirements').append(card);
    });
    coverageAreas.forEach((area,index)=>{const key=String(index);const label=create('label');const check=document.createElement('input');check.type='checkbox';check.checked=Boolean(state.coverage[key]);check.addEventListener('change',()=>{state.coverage[key]=check.checked;saveAndScore();});label.append(check,create('span','',area));byId('coverage').append(label);});
    byId('reviewer').value=state.reviewer||''; byId('reviewer').addEventListener('input',event=>{state.reviewer=event.target.value;saveAndScore();});
    byId('missing-count').value=state.missing_count||0; byId('missing-count').addEventListener('input',event=>{state.missing_count=Math.max(0,Number(event.target.value)||0);saveAndScore();});
    byId('notes').value=state.notes||''; byId('notes').addEventListener('input',event=>{state.notes=event.target.value;saveAndScore();});
    function metrics(){const rows=Object.values(state.requirements);const critical=rows.filter(row=>row.critical);const correctCritical=critical.filter(row=>row.verdict==='correct').length;const denominator=critical.length+state.missing_count;const recall=denominator===0?null:correctCritical/denominator;const anchorValues=rows.flatMap(row=>row.anchors);const accuracy=anchorValues.length?anchorValues.filter(Boolean).length/anchorValues.length:0;const reviewed=rows.every(row=>row.verdict!=='unreviewed');const noBadRows=rows.every(row=>row.verdict==='correct');const coverageComplete=coverageAreas.every((_,index)=>state.coverage[String(index)]);const pass=Boolean(state.reviewer.trim())&&reviewed&&noBadRows&&coverageComplete&&state.missing_count===0&&recall!==null&&recall>=.95&&accuracy>=.95;return{recall,accuracy,reviewed,noBadRows,coverageComplete,pass};}
    function saveAndScore(){localStorage.setItem(stateKey,JSON.stringify(state));const result=metrics();byId('recall').textContent=result.recall===null?'Mark critical rows':Math.round(result.recall*100)+'%';byId('accuracy').textContent=Math.round(result.accuracy*100)+'%';byId('result').textContent=result.pass?'Human quality gate passed':'Review incomplete or failed';byId('result').className='result '+(result.pass?'pass':'fail');byId('export').disabled=!state.reviewer.trim()||!result.reviewed;}
    byId('export').addEventListener('click',()=>{const result=metrics();const exportData={reviewed_at:new Date().toISOString(),response_id:data.response_id,model:data.model,prompt_version:data.prompt_version,schema_version:data.schema_version,reviewer:state.reviewer.trim(),automatic_validation_passed:data.automatic_validation.passed,human_metrics:{critical_recall:result.recall,anchor_accuracy:result.accuracy,coverage_complete:result.coverageComplete,no_invented_or_partial_rows:result.noBadRows,passed:result.pass},missing_critical_requirement_count:state.missing_count,requirement_decisions:state.requirements,coverage:state.coverage,notes:state.notes};const blob=new Blob([JSON.stringify(exportData,null,2)+'\\n'],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='aido-phase2-human-review-'+data.response_id+'.json';link.click();URL.revokeObjectURL(link.href);});
    saveAndScore();
  </script>
</body>
</html>`;
}

async function writeReviewPackage(directoryPath, documents, report) {
  const directory = resolve(directoryPath);
  const repositoryRoot = resolve(".");
  if (directory === repositoryRoot || directory.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("The private review package must be written outside the repository.");
  }
  if (!report.automatic_validation?.passed) {
    throw new Error("A human review package can be created only after automatic grounding passes.");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const document of documents) {
    await writeFile(join(directory, `${document.kind}.pdf`), document.bytes, { mode: 0o600 });
  }
  const htmlPath = join(directory, "review.html");
  await writeFile(htmlPath, reviewHtml(report), { encoding: "utf8", mode: 0o600 });
  return htmlPath;
}

function revalidateSavedReport(report, project, documents, blocks) {
  if (
    report?.target_environment !== "staging"
    || report?.staging_project_ref !== STAGING_PROJECT_REF
    || report?.project_id !== project.id
    || report?.model_requested !== MODEL
    || report?.prompt_version !== PROMPT_VERSION
    || report?.schema_version !== SCHEMA_VERSION
    || report?.extraction?.schema_version !== report.schema_version
    || !report?.extraction
  ) throw new Error("The saved evaluation report does not match this staging evaluation.");

  const canonicalizedSourceLabels = bindAnchorsToKnownDocuments(report.extraction, documents);
  const deduplicatedSourceCoverageCount = canonicalizeSourceCoverage(report.extraction);
  normalizeAtomicClauseCoverageReceipt(report.extraction);
  const nullMetadataAnchorsRemoved = canonicalizeNullMetadataAnchors(report.extraction);
  const materializedAnchorCount = materializeAnchors(report.extraction, blocks);
  const validation = validateExtraction(report.extraction, documents, blocks, report.schema_version);
  report.document_metadata = documents.map((document) => ({
    id: document.id,
    kind: document.kind,
    filename: document.original_filename,
    mime_type: document.mime_type,
    size_bytes: document.size_bytes,
    content_hash: document.content_hash,
    page_count: document.page_text.length,
    ocr_supplement_page_count: document.page_ocr_supplements.filter(Boolean).length,
  }));
  report.automatic_validation = {
    passed: validation.passed,
    requirement_count: report.extraction.requirements.length,
    source_anchor_count: validation.anchors,
    ambiguity_count: report.extraction.ambiguities.length,
    source_coverage_count: report.extraction.source_coverage.length,
    deduplicated_source_coverage_count: Math.max(
      Number(report.automatic_validation?.deduplicated_source_coverage_count ?? 0),
      deduplicatedSourceCoverageCount,
    ),
    null_metadata_anchors_removed: Math.max(
      Number(report.automatic_validation?.null_metadata_anchors_removed ?? 0),
      nullMetadataAnchorsRemoved,
    ),
    canonicalized_source_labels: Math.max(
      Number(report.automatic_validation?.canonicalized_source_labels ?? 0),
      canonicalizedSourceLabels,
    ),
    materialized_anchor_count: Math.max(
      Number(report.automatic_validation?.materialized_anchor_count ?? 0),
      materializedAnchorCount,
    ),
    issues: validation.issues,
    human_review_required: true,
  };
  return { privateReport: report, publicSummary: publicSummaryFromReport(report) };
}

async function runEvaluation(apiKey, project, documents, blocks, anchoredText, checklistReference) {
  const idempotencyKey = createHash("sha256")
    .update([
      PROMPT_VERSION,
      MODEL,
      project.id,
      checklistReference.sha256,
      ...documents.map((document) => document.content_hash),
    ].join(":"))
    .digest("hex");
  const startedAt = Date.now();
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: REASONING_EFFORT },
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      instructions: [
        "Extract only explicit assignment and rubric requirements from the anchored source blocks.",
        "The source_coverage object has one required property per anchor. Classify every property exactly once; this is a structurally complete receipt, not optional commentary.",
        "Give every requirement a unique requirement_id and never reuse an ID.",
        "A structural_hint, locally_incomplete_text flag, and atomic_action_clauses list are deterministic parser signals; the quoted atomic clause text is copied verbatim from its source block.",
        "Every candidate_student_action block describes a numbered, student-directed assessed action and must be classified as assignment_requirement and cited by at least one returned requirement.",
        "The atomic_clause_coverage object has one required property per complete atomic action clause. Copy its supplied source_text and source_text_sha256 exactly.",
        "Map every atomic clause to its own unique returned requirement_id. Never map two clauses to one requirement and never merge clauses.",
        "The mapped requirement must cite only the clause's source block, and its requirement field must equal the complete atomic clause verbatim. Every command verb, deliverable, or constraint must also be a visible contiguous span within that clause.",
        "Every source_coverage block classified as assignment_requirement or rubric_requirement must be cited by at least one returned requirement.",
        "Never cite a context_only or unusable_or_incomplete block as an assignment requirement.",
        `Mark has_incomplete_text true whenever locally_incomplete_text is true or visible source text is truncated, corrupted, or ends mid-phrase. Its source_coverage notes value must be exactly ${JSON.stringify(INCOMPLETE_SOURCE_COVERAGE_NOTE)}.`,
        `Every incomplete block must be classified unusable_or_incomplete and cited by exactly one ambiguity with severity important, issue ${JSON.stringify(INCOMPLETE_SOURCE_ISSUE)}, and question_for_lecturer ${JSON.stringify(INCOMPLETE_SOURCE_QUESTION)}. That ambiguity must cite only the incomplete block.`,
        "Do not create or anchor any requirement, assignment metadata, citation rule, or integrity-policy signal from an incomplete block, even when part of the fragment appears understandable.",
        "Never repair OCR, finish a trailing fragment, insert missing words, paraphrase, or infer a completion for truncated text. The missing clause remains unresolved until a complete source version is available.",
        "Every returned requirement, ambiguity, citation rule, and integrity signal must cite one or more exact anchor_id values from the supplied blocks.",
        "Choose an anchor only when that block directly supports the returned statement.",
        "Do not infer missing requirements. Record uncertainty or document conflicts as ambiguities.",
        "Separate explicit academic-integrity or AI-use rules from ordinary assignment requirements.",
        "Include every explicit learning outcome and every rubric criterion with its performance descriptors.",
        "Treat each distinct bullet or numbered instruction block as a separate coverage obligation when it states a student action or learning outcome.",
        "Do not treat the overall assessment weight as a rubric-criterion weight.",
        "Do not turn contextual descriptions into standalone student requirements unless the source makes them obligations or assessment criteria.",
        "Learning-support links, extension procedures, programme-handbook directions, and similar help notices are context_only unless they explicitly define the assessed work.",
        "If a word count, citation style, AI-use rule, or rubric-criterion weight is absent, do not invent one.",
        "Populate every assignment_metadata field; use null with no anchors when the source does not state a value.",
        "Every non-null assignment_metadata value must cite a directly supporting anchor.",
        "Every rubric requirement must cite its complete local_ocr_table_row anchor, never a table header or row-heading fragment.",
        "Record every material conflict where different source blocks describe different deliverable types, submission targets, or deadlines.",
      ].join(" "),
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: [
            "Anchored source blocks follow. The anchor ID inside square brackets is the only source identifier you may return.",
            anchoredText,
            "Produce the complete source-anchored requirement extraction using the required JSON schema.",
          ].join("\n\n"),
        }],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "aido_phase2_requirement_extraction",
          strict: true,
          schema: extractionSchema,
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const latencyMs = Date.now() - startedAt;
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.status !== "completed") {
    const providerStatus = typeof payload?.status === "string" ? payload.status : "missing";
    const incompleteReason = typeof payload?.incomplete_details?.reason === "string"
      ? payload.incomplete_details.reason
      : "not_reported";
    const responseId = typeof payload?.id === "string" ? payload.id : "not_reported";
    throw new Error(
      `OpenAI evaluation failed with HTTP ${response.status}; status=${providerStatus}; reason=${incompleteReason}; response_id=${responseId}.`,
    );
  }
  const outputText = extractOutputText(payload);
  let extraction;
  try {
    extraction = JSON.parse(outputText);
  } catch {
    throw new Error("OpenAI returned output that was not valid JSON.");
  }
  const modelExtraction = structuredClone(extraction);
  normalizeSourceCoverageReceipt(extraction);
  normalizeAtomicClauseCoverageReceipt(extraction);
  const deduplicatedSourceCoverageCount = canonicalizeSourceCoverage(extraction);
  const canonicalizedSourceLabels = bindAnchorsToKnownDocuments(extraction, documents);
  const nullMetadataAnchorsRemoved = canonicalizeNullMetadataAnchors(extraction);
  const materializedAnchorCount = materializeAnchors(extraction, blocks);
  const validation = validateExtraction(extraction, documents, blocks);
  const usage = payload.usage ?? {};
  const result = {
    privateReport: {
      evaluated_at: new Date().toISOString(),
      target_environment: "staging",
      staging_project_ref: STAGING_PROJECT_REF,
      project_id: project.id,
      document_metadata: documents.map((document) => ({
        id: document.id,
        kind: document.kind,
        filename: document.original_filename,
        mime_type: document.mime_type,
        size_bytes: document.size_bytes,
        content_hash: document.content_hash,
        page_count: document.page_text.length,
        ocr_supplement_page_count: document.page_ocr_supplements.filter(Boolean).length,
      })),
      provider: "openai",
      model_requested: MODEL,
      model_returned: payload.model ?? null,
      fallback_model: FALLBACK_MODEL,
      reasoning_effort: REASONING_EFFORT,
      response_id: payload.id ?? null,
      prompt_version: PROMPT_VERSION,
      schema_version: SCHEMA_VERSION,
      human_checklist_reference: {
        version: checklistReference.version,
        sha256: checklistReference.sha256,
      },
      store: false,
      tools_enabled: false,
      searches_enabled: false,
      input_mode: "locally-extracted-anchored-text",
      anchoring_version: ANCHORING_VERSION,
      anchor_block_count: blocks.length,
      table_row_anchor_count: blocks.filter(
        (block) => block.extraction_method === "local_ocr_table_row",
      ).length,
      candidate_student_action_block_count: blocks.filter(
        (block) => block.structural_hint === "candidate_student_action",
      ).length,
      atomic_action_clause_count: atomicActionClauses(blocks).length,
      locally_incomplete_block_count: blocks.filter(
        (block) => block.locally_incomplete_text,
      ).length,
      coverage_required_block_count: coverageRequiredBlocks(blocks).length,
      ocr_supplement_page_count: documents.reduce(
        (count, document) => count + document.page_ocr_supplements.filter(Boolean).length,
        0,
      ),
      anchored_text_sha256: createHash("sha256").update(anchoredText).digest("hex"),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      latency_ms: latencyMs,
      usage: {
        input_tokens: Number(usage.input_tokens ?? 0),
        cached_input_tokens: Number(usage.input_tokens_details?.cached_tokens ?? 0),
        cache_write_input_tokens: Number(
          usage.input_tokens_details?.cache_write_tokens ?? 0
        ),
        output_tokens: Number(usage.output_tokens ?? 0),
        estimated_cost_microusd: calculateCostMicrousd(usage),
      },
      automatic_validation: {
        passed: validation.passed,
        requirement_count: extraction.requirements.length,
        source_anchor_count: validation.anchors,
        ambiguity_count: extraction.ambiguities.length,
        source_coverage_count: extraction.source_coverage.length,
        deduplicated_source_coverage_count: deduplicatedSourceCoverageCount,
        null_metadata_anchors_removed: nullMetadataAnchorsRemoved,
        canonicalized_source_labels: canonicalizedSourceLabels,
        materialized_anchor_count: materializedAnchorCount,
        issues: validation.issues,
        human_review_required: true,
      },
      anchor_registry: blocks.map((block) => ({
        anchor_id: block.id,
        document_id: block.document_id,
        source_id: block.source_id,
        filename: block.filename,
        page_number: block.page_number,
        extraction_method: block.extraction_method,
        structural_hint: block.structural_hint,
        locally_incomplete_text: block.locally_incomplete_text,
        atomic_clauses: block.atomic_clauses,
        text_sha256: block.text_sha256,
        text: block.text,
      })),
      model_extraction: modelExtraction,
      extraction,
    },
    publicSummary: null,
  };
  result.publicSummary = publicSummaryFromReport(result.privateReport);
  return result;
}

function runEvaluatorContractSelfTest() {
  const calculatedCost = calculateCostMicrousd({
    input_tokens: 1_000_000,
    input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 200_000 },
    output_tokens: 100_000,
  });
  if (calculatedCost !== 1_132_500) {
    throw new Error("The model price-accounting self-test failed.");
  }

  const document = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "rubric",
    original_filename: "contract.pdf",
    page_text: ["Contract table row"],
  };
  const approvalChecklist = {
    provider_request_approval: {
      approved_for_provider_request: true,
      reviewer: "Phase 2 reviewer",
      reviewed_at: "2026-07-20T00:00:00.000Z",
      scope: {
        target_environment: "staging",
        staging_project_ref: STAGING_PROJECT_REF,
        project_id: document.id,
        model_requested: MODEL,
        prompt_version: PROMPT_VERSION,
        schema_version: SCHEMA_VERSION,
        anchoring_version: ANCHORING_VERSION,
      },
    },
  };
  if (!checklistHasProviderRequestApproval(approvalChecklist, document.id)) {
    throw new Error("The provider-request approval checklist self-test failed.");
  }
  const unapprovedChecklist = structuredClone(approvalChecklist);
  unapprovedChecklist.provider_request_approval.scope.prompt_version = "previous-prompt";
  if (checklistHasProviderRequestApproval(unapprovedChecklist, document.id)) {
    throw new Error("The provider-request approval mismatch self-test failed.");
  }
  const blocks = [
    {
      id: "rubric-p1-b001",
      document_id: document.id,
      source_id: "rubric",
      filename: document.original_filename,
      page_number: 1,
      text: "Contract table row",
      extraction_method: "local_ocr_table_row",
      structural_hint: "rubric_row",
      locally_incomplete_text: false,
      atomic_clauses: [],
      text_sha256: createHash("sha256").update("Contract table row").digest("hex"),
    },
    {
      id: "rubric-p1-b002",
      document_id: document.id,
      source_id: "rubric",
      filename: document.original_filename,
      page_number: 1,
      text: "Contract header",
      extraction_method: "local_ocr",
      structural_hint: "unclassified",
      locally_incomplete_text: false,
      atomic_clauses: [],
      text_sha256: createHash("sha256").update("Contract header").digest("hex"),
    },
  ];
  const metadata = {
    assessment_type: { value: "Contract", source_anchors: [{ anchor_id: blocks[0].id }] },
    overall_weight_percent: { value: null, source_anchors: [] },
    word_count: { value: null, source_anchors: [] },
    citation_style: { value: null, source_anchors: [] },
    file_format: { value: null, source_anchors: [] },
    submission_destination: { value: null, source_anchors: [] },
    deadline_text: { value: null, source_anchors: [] },
  };
  const extraction = {
    schema_version: SCHEMA_VERSION,
    source_coverage: [{
      anchor_id: blocks[0].id,
      classification: "rubric_requirement",
      has_incomplete_text: false,
      notes: "Complete contract row.",
    }],
    atomic_clause_coverage: [],
    assignment_metadata: metadata,
    requirements: [{
      requirement_id: "req-contract-001",
      requirement: "Contract requirement",
      category: "rubric",
      command_verbs: [],
      deliverables: [],
      constraints: [],
      rubric_weight_percent: null,
      source_anchors: [{ anchor_id: blocks[0].id }],
      confidence: "high",
      needs_student_confirmation: false,
    }],
    ambiguities: [],
    citation_rules: [],
    integrity_policy_signals: [],
    document_warnings: [],
  };
  materializeAnchors(extraction, blocks);
  const positive = validateExtraction(extraction, [document], blocks);
  if (!positive.passed) throw new Error("The positive evaluator contract self-test failed.");

  const nullMetadataAnchor = structuredClone(extraction);
  nullMetadataAnchor.assignment_metadata.citation_style.source_anchors = [{
    anchor_id: blocks[0].id,
  }];
  if (
    canonicalizeNullMetadataAnchors(nullMetadataAnchor) !== 1
    || nullMetadataAnchor.assignment_metadata.citation_style.source_anchors.length !== 0
    || !validateExtraction(nullMetadataAnchor, [document], blocks).passed
  ) throw new Error("The null-metadata anchor canonicalization self-test failed.");

  const headerOnly = structuredClone(extraction);
  headerOnly.requirements[0].source_anchors = [{ anchor_id: blocks[1].id }];
  materializeAnchors(headerOnly, blocks);
  const negative = validateExtraction(headerOnly, [document], blocks);
  if (negative.issues.rubric_requirement_without_row_anchor !== 1 || negative.passed) {
    throw new Error("The header-only evaluator contract self-test failed.");
  }

  const missingCoverage = structuredClone(extraction);
  missingCoverage.source_coverage = [];
  const missingCoverageValidation = validateExtraction(missingCoverage, [document], blocks);
  if (missingCoverageValidation.issues.source_coverage_mismatch !== 1 || missingCoverageValidation.passed) {
    throw new Error("The missing source-coverage contract self-test failed.");
  }

  const truncatedBlock = {
    ...structuredClone(blocks[0]),
    id: "rubric-p1-b004",
    text: "Preventive measures should include",
    locally_incomplete_text: true,
    atomic_clauses: [],
    text_sha256: createHash("sha256").update("Preventive measures should include").digest("hex"),
  };
  const blocksWithTruncation = [...blocks, truncatedBlock];
  const omittedTruncation = structuredClone(extraction);
  omittedTruncation.source_coverage.push({
    anchor_id: truncatedBlock.id,
    classification: "unusable_or_incomplete",
    has_incomplete_text: true,
    notes: INCOMPLETE_SOURCE_COVERAGE_NOTE,
  });
  omittedTruncation.ambiguities = [{
    issue: INCOMPLETE_SOURCE_ISSUE,
    severity: "important",
    source_anchors: [{ anchor_id: truncatedBlock.id }],
    question_for_lecturer: INCOMPLETE_SOURCE_QUESTION,
  }];
  materializeAnchors(omittedTruncation, blocksWithTruncation);
  if (!validateExtraction(omittedTruncation, [document], blocksWithTruncation).passed) {
    throw new Error("The fail-closed truncated-source contract self-test failed.");
  }
  const truncatedCoverageSchema = coverageDecisionSchemaForBlock(truncatedBlock);
  if (
    truncatedCoverageSchema.properties.classification.enum[0] !== "unusable_or_incomplete"
    || truncatedCoverageSchema.properties.has_incomplete_text.enum[0] !== true
    || truncatedCoverageSchema.properties.notes.enum[0] !== INCOMPLETE_SOURCE_COVERAGE_NOTE
  ) throw new Error("The strict truncated-source schema self-test failed.");

  const incompleteWithoutAmbiguity = structuredClone(omittedTruncation);
  incompleteWithoutAmbiguity.ambiguities = [];
  const incompleteValidation = validateExtraction(
    incompleteWithoutAmbiguity,
    [document],
    blocksWithTruncation,
  );
  if (
    incompleteValidation.issues.incomplete_source_without_ambiguity !== 1
    || incompleteValidation.passed
  ) throw new Error("The incomplete-source ambiguity contract self-test failed.");

  const completedAmbiguity = structuredClone(omittedTruncation);
  completedAmbiguity.ambiguities[0].issue =
    "Source text is incomplete and probably requires preventive education.";
  const completedAmbiguityValidation = validateExtraction(
    completedAmbiguity,
    [document],
    blocksWithTruncation,
  );
  if (
    completedAmbiguityValidation.issues.incomplete_source_ambiguity_mismatch !== 1
    || completedAmbiguityValidation.passed
  ) throw new Error("The truncated-source ambiguity completion guard self-test failed.");

  const completedCoverageNote = structuredClone(omittedTruncation);
  completedCoverageNote.source_coverage[1].notes =
    "Excluded because the missing ending probably requests preventive education.";
  const completedCoverageNoteValidation = validateExtraction(
    completedCoverageNote,
    [document],
    blocksWithTruncation,
  );
  if (
    completedCoverageNoteValidation.issues.incomplete_source_coverage_note_mismatch !== 1
    || completedCoverageNoteValidation.passed
  ) throw new Error("The truncated-source coverage-note completion guard self-test failed.");

  const semanticTruncationLeak = structuredClone(omittedTruncation);
  semanticTruncationLeak.citation_rules.push({
    rule: "Use the completed preventive-measures rule.",
    source_anchors: [{ anchor_id: truncatedBlock.id }],
  });
  materializeAnchors(semanticTruncationLeak, blocksWithTruncation);
  const semanticTruncationValidation = validateExtraction(
    semanticTruncationLeak,
    [document],
    blocksWithTruncation,
  );
  if (
    semanticTruncationValidation.issues.incomplete_source_semantic_output_prohibited !== 1
    || semanticTruncationValidation.passed
  ) throw new Error("The truncated-source semantic-output guard self-test failed.");

  const locallyIncompleteNotMarked = structuredClone(omittedTruncation);
  locallyIncompleteNotMarked.source_coverage[1].has_incomplete_text = false;
  const locallyIncompleteValidation = validateExtraction(
    locallyIncompleteNotMarked,
    [document],
    blocksWithTruncation,
  );
  if (
    locallyIncompleteValidation.issues.locally_incomplete_source_not_marked !== 1
    || locallyIncompleteValidation.passed
  ) throw new Error("The local incomplete-source override self-test failed.");

  const classifiedTruncation = structuredClone(omittedTruncation);
  classifiedTruncation.source_coverage[1].classification = "rubric_requirement";
  const classifiedTruncationValidation = validateExtraction(
    classifiedTruncation,
    [document],
    blocksWithTruncation,
  );
  if (
    classifiedTruncationValidation.issues.incomplete_source_classification_mismatch !== 1
    || classifiedTruncationValidation.passed
  ) throw new Error("The truncated-source classification guard self-test failed.");

  const completedTruncation = structuredClone(omittedTruncation);
  completedTruncation.requirements.push({
    requirement_id: "req-completed-truncation",
    requirement: "Preventive measures should include education and enforcement.",
    category: "rubric",
    command_verbs: [],
    deliverables: [],
    constraints: [],
    rubric_weight_percent: null,
    source_anchors: [{ anchor_id: truncatedBlock.id }],
    confidence: "low",
    needs_student_confirmation: true,
  });
  materializeAnchors(completedTruncation, blocksWithTruncation);
  const completedTruncationValidation = validateExtraction(
    completedTruncation,
    [document],
    blocksWithTruncation,
  );
  if (
    completedTruncationValidation.issues.incomplete_source_requirement_prohibited !== 1
    || completedTruncationValidation.passed
  ) throw new Error("The truncated-source completion prohibition self-test failed.");

  const identicalDuplicate = structuredClone(extraction);
  identicalDuplicate.source_coverage.push(structuredClone(identicalDuplicate.source_coverage[0]));
  if (
    canonicalizeSourceCoverage(identicalDuplicate) !== 1
    || identicalDuplicate.source_coverage.length !== 1
    || !validateExtraction(identicalDuplicate, [document], blocks).passed
  ) throw new Error("The identical source-coverage deduplication self-test failed.");

  const conflictingDuplicate = structuredClone(extraction);
  conflictingDuplicate.source_coverage.push({
    ...structuredClone(conflictingDuplicate.source_coverage[0]),
    classification: "context_only",
  });
  if (
    canonicalizeSourceCoverage(conflictingDuplicate) !== 0
    || validateExtraction(conflictingDuplicate, [document], blocks).passed
  ) throw new Error("The conflicting source-coverage deduplication self-test failed.");

  const candidateBlock = {
    id: "rubric-p1-b003",
    document_id: document.id,
    source_id: "rubric",
    filename: document.original_filename,
    page_number: 1,
    text: "2. As you progress, read the case studies to understand corruption cases to understand the impact on society.",
    extraction_method: "pdf_text",
    structural_hint: "candidate_student_action",
    locally_incomplete_text: false,
    atomic_clauses: [],
    text_sha256: createHash("sha256").update("2. As you progress, read the case studies to understand corruption cases to understand the impact on society.").digest("hex"),
  };
  candidateBlock.atomic_clauses = extractAtomicActionClauses(candidateBlock);
  const candidateMissing = structuredClone(extraction);
  candidateMissing.source_coverage.push({
    anchor_id: candidateBlock.id,
    classification: "context_only",
    has_incomplete_text: false,
    notes: "Incorrect context classification for contract test.",
  });
  const candidateValidation = validateExtraction(
    candidateMissing,
    [document],
    [...blocks, candidateBlock],
  );
  if (
    candidateValidation.issues.candidate_student_action_without_requirement !== 1
    || candidateValidation.passed
  ) throw new Error("The candidate-student-action contract self-test failed.");

  const atomicCoverage = structuredClone(extraction);
  atomicCoverage.source_coverage.push({
    anchor_id: candidateBlock.id,
    classification: "assignment_requirement",
    has_incomplete_text: false,
    notes: "Numbered student action.",
  });
  const atomicRequirements = candidateBlock.atomic_clauses.map((clause, index) => ({
    requirement_id: `req-contract-atomic-${index + 1}`,
    requirement: clause.source_text,
    category: "task",
    command_verbs: [],
    deliverables: [],
    constraints: [],
    rubric_weight_percent: null,
    source_anchors: [{ anchor_id: candidateBlock.id }],
    confidence: "high",
    needs_student_confirmation: false,
  }));
  atomicCoverage.requirements.push(...atomicRequirements);
  atomicCoverage.atomic_clause_coverage = candidateBlock.atomic_clauses.map((clause, index) => ({
    clause_id: clause.id,
    requirement_id: atomicRequirements[index].requirement_id,
    source_text: clause.source_text,
    source_text_sha256: clause.text_sha256,
    notes: "One complete clause maps to one dedicated requirement.",
  }));
  materializeAnchors(atomicCoverage, [...blocks, candidateBlock]);
  if (!validateExtraction(atomicCoverage, [document], [...blocks, candidateBlock]).passed) {
    throw new Error("The complete atomic-clause coverage self-test failed.");
  }

  const missingAtomicPurpose = structuredClone(atomicCoverage);
  missingAtomicPurpose.requirements[1].requirement = "read the case studies and infer a purpose";
  if (
    validateExtraction(missingAtomicPurpose, [document], [...blocks, candidateBlock])
      .issues.atomic_clause_requirement_mismatch !== 1
  ) throw new Error("The missing atomic-purpose contract self-test failed.");

  const mergedAtomicClauses = structuredClone(atomicCoverage);
  mergedAtomicClauses.atomic_clause_coverage[1].requirement_id =
    mergedAtomicClauses.atomic_clause_coverage[0].requirement_id;
  const mergedAtomicValidation = validateExtraction(
    mergedAtomicClauses,
    [document],
    [...blocks, candidateBlock],
  );
  if (
    mergedAtomicValidation.issues.atomic_clause_nonunique_requirement !== 1
    || mergedAtomicValidation.passed
  ) throw new Error("The merged atomic-clause prohibition self-test failed.");

  const tamperedAtomicReceipt = structuredClone(atomicCoverage);
  tamperedAtomicReceipt.atomic_clause_coverage[0].source_text = "read a different source";
  if (
    validateExtraction(tamperedAtomicReceipt, [document], [...blocks, candidateBlock])
      .issues.atomic_clause_receipt_mismatch !== 1
  ) throw new Error("The exact atomic-clause receipt self-test failed.");

  const truncatedCandidateBlock = {
    ...structuredClone(candidateBlock),
    id: "rubric-p1-b005",
    text: "3. You should explain the impact and",
    locally_incomplete_text: true,
  };
  truncatedCandidateBlock.atomic_clauses = extractAtomicActionClauses(truncatedCandidateBlock);
  if (truncatedCandidateBlock.atomic_clauses.length !== 0) {
    throw new Error("The truncated atomic-clause suppression self-test failed.");
  }

  constrainSourceAnchorSchema([...blocks, candidateBlock]);
  const coverageSchema = extractionSchema.properties.source_coverage;
  const expectedCoverageIds = [blocks[0].id, candidateBlock.id];
  if (
    coverageSchema.required.length !== expectedCoverageIds.length
    || expectedCoverageIds.some((anchorId) => !coverageSchema.required.includes(anchorId))
    || Object.keys(coverageSchema.properties).length !== expectedCoverageIds.length
  ) throw new Error("The unique source-coverage schema self-test failed.");
  const atomicCoverageSchema = extractionSchema.properties.atomic_clause_coverage;
  const expectedClauseIds = candidateBlock.atomic_clauses.map((clause) => clause.id);
  if (
    atomicCoverageSchema.required.length !== expectedClauseIds.length
    || expectedClauseIds.some((clauseId) => !atomicCoverageSchema.required.includes(clauseId))
    || Object.keys(atomicCoverageSchema.properties).length !== expectedClauseIds.length
    || atomicCoverageSchema.properties[expectedClauseIds[0]].properties.source_text.enum[0]
      !== candidateBlock.atomic_clauses[0].source_text
    || atomicCoverageSchema.properties[expectedClauseIds[0]].properties.source_text_sha256.enum[0]
      !== candidateBlock.atomic_clauses[0].text_sha256
  ) throw new Error("The unique atomic-clause coverage schema self-test failed.");

  const normalizedReceipt = {
    source_coverage: {
      [blocks[0].id]: {
        classification: "rubric_requirement",
        has_incomplete_text: false,
        notes: "Complete contract row.",
      },
    },
  };
  normalizeSourceCoverageReceipt(normalizedReceipt);
  if (
    normalizedReceipt.source_coverage.length !== 1
    || normalizedReceipt.source_coverage[0].anchor_id !== blocks[0].id
  ) throw new Error("The source-coverage receipt normalization self-test failed.");

  const normalizedAtomicReceipt = {
    atomic_clause_coverage: {
      [candidateBlock.atomic_clauses[0].id]: {
        requirement_id: atomicRequirements[0].requirement_id,
        source_text: candidateBlock.atomic_clauses[0].source_text,
        source_text_sha256: candidateBlock.atomic_clauses[0].text_sha256,
        notes: "Contract receipt.",
      },
    },
  };
  normalizeAtomicClauseCoverageReceipt(normalizedAtomicReceipt);
  if (
    normalizedAtomicReceipt.atomic_clause_coverage.length !== 1
    || normalizedAtomicReceipt.atomic_clause_coverage[0].clause_id
      !== candidateBlock.atomic_clauses[0].id
  ) throw new Error("The atomic-clause receipt normalization self-test failed.");
}

if (process.argv.includes("--self-test")) {
  runEvaluatorContractSelfTest();
  console.log(JSON.stringify({ passed: true, provider_request_made: false }, null, 2));
  process.exit(0);
}

await loadEnvironment();
const supabaseUrl = requiredEnvironment("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
if (supabaseUrl !== STAGING_SUPABASE_URL) {
  throw new Error(`NEXT_PUBLIC_SUPABASE_URL must exactly target isolated staging (${STAGING_SUPABASE_URL}).`);
}
if (process.env.AIDO_BILLING_CONFIG_TARGET !== "staging") {
  throw new Error("AIDO_BILLING_CONFIG_TARGET must be staging.");
}
const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
const outputPath = option("--output");
if (!outputPath) throw new Error("Use --output with a private path outside the repository.");
const resolvedOutputPath = resolve(outputPath);
const repositoryRoot = resolve(".");
if (resolvedOutputPath === repositoryRoot || resolvedOutputPath.startsWith(`${repositoryRoot}${sep}`)) {
  throw new Error("The private evaluation report must be written outside the repository.");
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const project = await resolveProject(admin);
const documents = await loadDocuments(admin, project.id);
await extractPdfPageText(documents);
const { blocks, anchoredText } = buildAnchoredBlocks(documents);
constrainSourceAnchorSchema(blocks);
const reuseReportPath = option("--reuse-report");
const checklistReference = await loadReviewChecklist(
  option("--review-checklist"),
  project,
  documents,
  repositoryRoot,
);
if (!process.argv.includes("--dry-run") && !reuseReportPath && !checklistReference) {
  throw new Error("A matching private --review-checklist is required before a provider request.");
}
if (process.argv.includes("--dry-run")) {
  const anchorRegistryOutput = option("--anchor-registry-output");
  let privateAnchorRegistryPath = null;
  if (anchorRegistryOutput) {
    const resolvedAnchorRegistryPath = resolve(anchorRegistryOutput);
    if (
      resolvedAnchorRegistryPath === repositoryRoot
      || resolvedAnchorRegistryPath.startsWith(`${repositoryRoot}${sep}`)
    ) throw new Error("The private anchor registry must be written outside the repository.");
    await mkdir(dirname(resolvedAnchorRegistryPath), { recursive: true, mode: 0o700 });
    await writeFile(resolvedAnchorRegistryPath, `${JSON.stringify({
      generated_at: new Date().toISOString(),
      target_environment: "staging",
      staging_project_ref: STAGING_PROJECT_REF,
      project_id: project.id,
      prompt_version: PROMPT_VERSION,
      schema_version: SCHEMA_VERSION,
      provider_request_made: false,
      anchor_registry: blocks.map((block) => ({
        anchor_id: block.id,
        source_id: block.source_id,
        page_number: block.page_number,
        extraction_method: block.extraction_method,
        structural_hint: block.structural_hint,
        locally_incomplete_text: block.locally_incomplete_text,
        atomic_clauses: block.atomic_clauses,
        text_sha256: block.text_sha256,
        text: block.text,
      })),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    privateAnchorRegistryPath = resolvedAnchorRegistryPath;
  }
  console.log(JSON.stringify({
    ready: true,
    target_environment: "staging",
    staging_project_ref: STAGING_PROJECT_REF,
    project_id: project.id,
    provider: "openai",
    model: MODEL,
    fallback_model: FALLBACK_MODEL,
    automatic_fallback_enabled: false,
    reasoning_effort: REASONING_EFFORT,
    prompt_version: PROMPT_VERSION,
    schema_version: SCHEMA_VERSION,
    document_count: documents.length,
    document_page_counts: Object.fromEntries(
      documents.map((document) => [document.kind, document.page_text.length]),
    ),
    anchor_block_count: blocks.length,
    table_row_anchor_count: blocks.filter(
      (block) => block.extraction_method === "local_ocr_table_row",
    ).length,
    candidate_student_action_block_count: blocks.filter(
      (block) => block.structural_hint === "candidate_student_action",
    ).length,
    atomic_action_clause_count: atomicActionClauses(blocks).length,
    locally_incomplete_block_count: blocks.filter(
      (block) => block.locally_incomplete_text,
    ).length,
    coverage_required_block_count: coverageRequiredBlocks(blocks).length,
    ocr_supplement_page_count: documents.reduce(
      (count, document) => count + document.page_ocr_supplements.filter(Boolean).length,
      0,
    ),
    anchored_text_chars: anchoredText.length,
    max_anchored_text_chars: MAX_ANCHORED_TEXT_CHARS,
    provider_request_made: false,
    human_checklist_reference: checklistReference
      ? { version: checklistReference.version, sha256: checklistReference.sha256 }
      : null,
    private_anchor_registry_path: privateAnchorRegistryPath,
  }, null, 2));
  process.exit(0);
}
const result = reuseReportPath
  ? revalidateSavedReport(
    JSON.parse(await readFile(resolve(reuseReportPath), "utf8")),
    project,
    documents,
    blocks,
  )
  : await runEvaluation(
    requiredEnvironment("OPENAI_API_KEY"),
    project,
    documents,
    blocks,
    anchoredText,
    checklistReference,
  );
await mkdir(dirname(resolvedOutputPath), { recursive: true, mode: 0o700 });
await writeFile(resolvedOutputPath, `${JSON.stringify(result.privateReport, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
const reviewDirectory = option("--review-directory");
const reviewPath = reviewDirectory && result.privateReport.automatic_validation.passed
  ? await writeReviewPackage(reviewDirectory, documents, result.privateReport)
  : null;
console.log(JSON.stringify({
  ...result.publicSummary,
  private_report_path: resolvedOutputPath,
  private_review_path: reviewPath,
  review_package_skipped_reason: reviewDirectory && !result.privateReport.automatic_validation.passed
    ? "automatic_validation_failed"
    : null,
}, null, 2));
if (!result.privateReport.automatic_validation.passed) process.exitCode = 2;
