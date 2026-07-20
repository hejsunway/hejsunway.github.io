import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const apiUrl = process.env.API_URL;
const anonKey = process.env.ANON_KEY;
const serviceRoleKey = process.env.SERVICE_ROLE_KEY;
const integrationTarget = process.env.AIDO_INTEGRATION_TARGET ?? "local";

if (!apiUrl || !anonKey) {
  throw new Error("Supabase API_URL and ANON_KEY are required.");
}

const parsedApiUrl = new URL(apiUrl);
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
if (integrationTarget === "local") {
  if (!localHostnames.has(parsedApiUrl.hostname)) {
    throw new Error("The default Phase 1 integration test is local-only.");
  }
} else if (integrationTarget === "staging") {
  const stagingProjectRef = process.env.AIDO_STAGING_PROJECT_REF;
  if (process.env.AIDO_ALLOW_STAGING_WRITE_TEST !== "1") {
    throw new Error("Set AIDO_ALLOW_STAGING_WRITE_TEST=1 to authorize temporary staging fixtures.");
  }
  if (!stagingProjectRef || !/^[a-z]{20}$/.test(stagingProjectRef)) {
    throw new Error("AIDO_STAGING_PROJECT_REF must be the exact 20-letter staging project ref.");
  }
  if (stagingProjectRef === "gmqlmqdqpytgjxolgrwq") {
    throw new Error("The shared TutorPakar production project is not an allowed staging target.");
  }
  if (parsedApiUrl.hostname !== `${stagingProjectRef}.supabase.co`) {
    throw new Error("API_URL does not match AIDO_STAGING_PROJECT_REF.");
  }
} else {
  throw new Error("AIDO_INTEGRATION_TARGET must be local or staging.");
}

const useStagingPreprovisionedUsers = integrationTarget === "staging"
  && process.env.AIDO_STAGING_PREPROVISIONED_USERS === "1";
if (!serviceRoleKey && !useStagingPreprovisionedUsers) {
  throw new Error(
    "SERVICE_ROLE_KEY is required unless guarded staging self-sign-up is explicitly enabled.",
  );
}

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };
const admin = serviceRoleKey ? createClient(apiUrl, serviceRoleKey, clientOptions) : null;
const owner = createClient(apiUrl, anonKey, clientOptions);
const unrelated = createClient(apiUrl, anonKey, clientOptions);
const suffix = randomUUID();
const testEmailDomain = integrationTarget === "staging" ? "aidofor.me" : "example.test";
const ownerEmail = process.env.AIDO_TEST_OWNER_EMAIL
  ?? `phase1-owner-${suffix}@${testEmailDomain}`;
const unrelatedEmail = process.env.AIDO_TEST_UNRELATED_EMAIL
  ?? `phase1-other-${suffix}@${testEmailDomain}`;
const password = process.env.AIDO_TEST_PASSWORD ?? `Aido-${randomUUID()}-9a`;
const preprovisionedOwnerId = process.env.AIDO_TEST_OWNER_ID;
const preprovisionedUnrelatedId = process.env.AIDO_TEST_UNRELATED_ID;
const bucket = "aido-assignment-files";

if (
  useStagingPreprovisionedUsers
  && (!preprovisionedOwnerId || !preprovisionedUnrelatedId || !process.env.AIDO_TEST_PASSWORD)
) {
  throw new Error("Preprovisioned staging users require both IDs and the temporary password.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createUser(client, email) {
  if (useStagingPreprovisionedUsers) {
    const id = email === ownerEmail ? preprovisionedOwnerId : preprovisionedUnrelatedId;
    return { id, email };
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error(`Could not create ${email}`);
  return data.user;
}

async function signInUser(client, email) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

let ownerUser;
let unrelatedUser;
let projectId;
const uploadedPaths = [];

try {
  ownerUser = await createUser(owner, ownerEmail);
  unrelatedUser = await createUser(unrelated, unrelatedEmail);

  await signInUser(owner, ownerEmail);
  await signInUser(unrelated, unrelatedEmail);

  if (admin) {
    const { error: membershipError } = await admin.from("aido_product_memberships").insert([
      { user_id: ownerUser.id, status: "active", role: "student" },
      { user_id: unrelatedUser.id, status: "active", role: "student" },
    ]);
    if (membershipError) throw membershipError;
  } else {
    const [{ error: ownerMembershipError }, { error: unrelatedMembershipError }] = await Promise.all([
      owner.from("aido_product_memberships").insert({
        user_id: ownerUser.id,
        status: "active",
        role: "student",
      }),
      unrelated.from("aido_product_memberships").insert({
        user_id: unrelatedUser.id,
        status: "active",
        role: "student",
      }),
    ]);
    if (ownerMembershipError || unrelatedMembershipError) {
      throw ownerMembershipError ?? unrelatedMembershipError;
    }
  }

  const { data: createdProjectId, error: createError } = await owner.rpc("aido_create_project", {
    p_title: `Integration ${suffix}`,
    p_course_name: "Local verification",
    p_assignment_type: "Report",
    p_deadline: null,
    p_target_word_count: 1200,
    p_citation_style: "APA 7",
    p_integrity_mode: "planning_only",
    p_policy_text: "Planning and research assistance permitted.",
  });
  if (createError || !createdProjectId) throw createError ?? new Error("Project RPC returned no ID");
  projectId = createdProjectId;

  const content = new TextEncoder().encode("A real local integration-test assignment brief.\n");
  const contentHash = createHash("sha256").update(content).digest("hex");
  const storagePath = `${ownerUser.id}/${projectId}/${randomUUID()}-brief.txt`;
  const { error: uploadError } = await owner.storage.from(bucket).upload(storagePath, content, {
    contentType: "text/plain",
    upsert: false,
  });
  if (uploadError) throw uploadError;
  uploadedPaths.push(storagePath);

  const { error: registerError } = await owner.rpc("aido_register_assignment_document", {
    p_project_id: projectId,
    p_kind: "brief",
    p_original_filename: "brief.txt",
    p_storage_path: storagePath,
    p_mime_type: "text/plain",
    p_size_bytes: content.byteLength,
    p_content_hash: contentHash,
  });
  if (registerError) throw registerError;

  const { error: completeError } = await owner.rpc("aido_complete_project_setup", {
    p_project_id: projectId,
  });
  if (completeError) throw completeError;

  const invalidContent = new TextEncoder().encode("metadata mismatch fixture");
  const invalidPath = `${ownerUser.id}/${projectId}/${randomUUID()}-invalid.txt`;
  const { error: invalidUploadError } = await owner.storage.from(bucket).upload(invalidPath, invalidContent, {
    contentType: "text/plain",
    upsert: false,
  });
  if (invalidUploadError) throw invalidUploadError;
  uploadedPaths.push(invalidPath);
  const { error: invalidRegisterError } = await owner.rpc("aido_register_assignment_document", {
    p_project_id: projectId,
    p_kind: "rubric",
    p_original_filename: "invalid.txt",
    p_storage_path: invalidPath,
    p_mime_type: "text/plain",
    p_size_bytes: invalidContent.byteLength + 1,
    p_content_hash: createHash("sha256").update(invalidContent).digest("hex"),
  });
  assert(invalidRegisterError, "Mismatched uploaded-object metadata was accepted.");

  await owner.auth.signOut();
  const { error: resumedSignInError } = await owner.auth.signInWithPassword({ email: ownerEmail, password });
  if (resumedSignInError) throw resumedSignInError;
  const { data: resumedProject, error: resumedProjectError } = await owner
    .from("aido_writing_projects")
    .select("id,status,title")
    .eq("id", projectId)
    .single();
  if (resumedProjectError) throw resumedProjectError;
  assert(resumedProject.status === "active", "Project did not persist as active after sign-out/sign-in.");

  const { data: documents, error: documentError } = await owner
    .from("aido_assignment_documents")
    .select("id,storage_path")
    .eq("project_id", projectId);
  if (documentError) throw documentError;
  assert(documents.length === 1 && documents[0].storage_path === storagePath, "Persisted document metadata is incorrect.");

  const { data: leakedProjects, error: unrelatedReadError } = await unrelated
    .from("aido_writing_projects")
    .select("id")
    .eq("id", projectId);
  if (unrelatedReadError) throw unrelatedReadError;
  assert(leakedProjects.length === 0, "Unrelated user could read the owner project.");
  const { error: unrelatedDownloadError } = await unrelated.storage.from(bucket).download(storagePath);
  assert(unrelatedDownloadError, "Unrelated user could download the owner file.");

  const { error: storageCleanupError } = await owner.storage.from(bucket).remove([storagePath, invalidPath]);
  if (storageCleanupError) throw storageCleanupError;
  const { error: deleteError } = await owner.rpc("aido_delete_project", { p_project_id: projectId });
  if (deleteError) throw deleteError;

  const verificationClient = admin ?? owner;
  const [{ data: deletedRows, error: deletedRowsError }, { data: auditRows, error: auditError }] = await Promise.all([
    verificationClient.from("aido_writing_projects").select("id").eq("id", projectId),
    verificationClient.from("aido_project_deletion_audit").select("deleted_project_id").eq("deleted_project_id", projectId),
  ]);
  if (deletedRowsError || auditError) throw deletedRowsError ?? auditError;
  assert(deletedRows.length === 0, "Deleted project row still exists.");
  assert(auditRows.length === 1, "Project deletion did not create exactly one persistent audit row.");

  const { data: remainingObjects, error: remainingObjectsError } = await verificationClient.storage
    .from(bucket)
    .list(`${ownerUser.id}/${projectId}`, { limit: 100 });
  if (remainingObjectsError) throw remainingObjectsError;
  assert(remainingObjects.length === 0, "Deleted project still has stored objects.");

  console.log(`Phase 1 ${integrationTarget} integration flow passed.`);
} finally {
  if (projectId && ownerUser) {
    if (uploadedPaths.length) {
      await (admin ?? owner).storage.from(bucket).remove(uploadedPaths).catch(() => undefined);
    }
    await (admin ?? owner).from("aido_writing_projects").delete().eq("id", projectId);
  }
  if (admin) {
    if (ownerUser) await admin.auth.admin.deleteUser(ownerUser.id);
    if (unrelatedUser) await admin.auth.admin.deleteUser(unrelatedUser.id);
  } else {
    if (ownerUser) {
      await owner.from("aido_product_memberships").delete().eq("user_id", ownerUser.id);
    }
    if (unrelatedUser) {
      await unrelated.from("aido_product_memberships").delete().eq("user_id", unrelatedUser.id);
    }
    if (ownerUser || unrelatedUser) {
      console.log(
        `AIDO_STAGING_CLEANUP_USER_IDS=${[ownerUser?.id, unrelatedUser?.id].filter(Boolean).join(",")}`,
      );
    }
  }
}
