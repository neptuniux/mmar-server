import {PoolClient} from "pg";
import {AttributeInstance, ClassInstance, SceneInstance} from "../../../mmar-global-data-structure";
import {HTTP400Error} from "./middleware/error_handling/standard_errors.middleware";

export {sort_class_instances_by_reference, referenced_class_instances_of};

/**
 * @description - Orders class instances so that one referenced by another is written
 * first.
 *
 * WHY. A class instance is created together with its attributes, and a REFERENCE
 * attribute carries a role instance whose `uuid_has_reference_class_instance` is a
 * foreign key onto `class_instance`. Creating the batch in the order the client happened
 * to send it therefore fails outright whenever a reference points forward: the row it
 * names does not exist yet, and PostgreSQL rejects the whole transaction with
 * `fk_role_instance_reference_class_instance`.
 *
 * That is not a hypothetical shape. A URDF import builds a Joint whose "Parent link" and
 * "Child link" point at Link instances of the same scene, and any client that sends
 * them in a different order — a collaborative session rebuilding the array from a Y.Doc,
 * an import that appends, an undo that reinstates — hands the server a payload it
 * refuses to store, with an error naming a constraint rather than a model.
 *
 * The order a payload arrives in carries no meaning, so this makes the write independent
 * of it: dependencies first, and everything else exactly where it was.
 *
 * A CYCLE cannot be satisfied in one pass — two instances referencing each other need
 * one row to exist before the other does — so the order its members end up in is
 * unspecified, and the insert fails exactly as it did before. Nothing here masks that:
 * breaking a cycle needs deferred constraints, which is a schema decision rather than an
 * ordering one. What is guaranteed is that a cycle does not disturb the rest of the
 * batch, and that nothing is dropped from the write.
 */

/**
 * @description - The class instances this one names through its reference attributes,
 * table columns included: a table cell is an attribute instance in its own right and can
 * carry a reference like any other.
 * @param {ClassInstance} instance - The class instance to read.
 * @returns {Set<string>} - The uuids it refers to.
 */
function referenced_class_instances_of(instance: ClassInstance): Set<string> {
    const referenced = new Set<string>();

    const walk = (attributes: AttributeInstance[] | undefined) => {
        for (const attribute of attributes ?? []) {
            const uuid = attribute?.role_instance_from?.uuid_has_reference_class_instance;
            if (uuid) referenced.add(uuid);
            walk(attribute?.table_attributes);
        }
    };

    walk(instance?.attribute_instance);
    return referenced;
}

/**
 * @description - The same class instances, ordered so that every reference between them
 * points backwards.
 * @param {ClassInstance[]} instances - The instances about to be created.
 * @returns {ClassInstance[]} - The instances, dependencies first.
 */
function sort_class_instances_by_reference(instances: ClassInstance[]): ClassInstance[] {
    if (!Array.isArray(instances) || instances.length < 2) return instances ?? [];

    const by_uuid = new Map<string, ClassInstance>();
    for (const instance of instances) {
        const uuid = instance?.get_uuid?.() ?? instance?.uuid;
        // The first occurrence wins, matching how the collection difference dedupes.
        if (uuid && !by_uuid.has(uuid)) by_uuid.set(uuid, instance);
    }

    const ordered: ClassInstance[] = [];
    const placed = new Set<string>();
    const visiting = new Set<string>();

    const place = (instance: ClassInstance) => {
        const uuid = instance?.get_uuid?.() ?? instance?.uuid;
        if (!uuid || placed.has(uuid)) return;
        // Already on the stack: a cycle, which no order can satisfy. Stop descending so
        // the sort terminates; the batch still fails, on the same constraint as before.
        if (visiting.has(uuid)) return;

        visiting.add(uuid);
        for (const referenced_uuid of referenced_class_instances_of(instance)) {
            // Only what is being created in the SAME batch has to be ordered. Anything
            // else either already exists or is a dangling reference the database will
            // report on its own terms.
            const dependency = by_uuid.get(referenced_uuid);
            if (dependency) place(dependency);
        }
        visiting.delete(uuid);

        placed.add(uuid);
        ordered.push(instance);
    };

    for (const instance of instances) place(instance);

    // Anything without a uuid cannot be ordered or deduped; keep it, at the end, rather
    // than dropping it from the write.
    for (const instance of instances) {
        const uuid = instance?.get_uuid?.() ?? instance?.uuid;
        if (!uuid) ordered.push(instance);
    }

    return ordered;
}

/**
 * @description - A reference that names a class instance nothing can resolve.
 */
export type DanglingReference = {
    /** The instance whose attribute carries the reference. */
    source_uuid: string;
    source_name: string;
    /** The attribute instance holding it. */
    attribute_uuid: string;
    /** What it points at, and what is not there. */
    referenced_uuid: string;
};

/** Every class instance the payload itself brings, relation class instances included. */
function class_instance_uuids_of(scene: SceneInstance): Set<string> {
    const uuids = new Set<string>();
    for (const instance of [
        ...(scene?.class_instances ?? []),
        ...(scene?.relationclasses_instances ?? []),
    ]) {
        const uuid = instance?.get_uuid?.() ?? instance?.uuid;
        if (uuid) uuids.add(uuid);
    }
    return uuids;
}

/**
 * @description - Every class reference the payload makes, and who makes it. Walks the
 * same ground the writes do: each instance's attributes, their table columns, and the
 * attributes of its ports.
 * @param {SceneInstance} scene - The scene about to be written.
 * @returns {DanglingReference[]} - Every reference, before checking any of them.
 */
function class_references_of(scene: SceneInstance): DanglingReference[] {
    const found: DanglingReference[] = [];

    const walk = (
        attributes: AttributeInstance[] | undefined,
        source_uuid: string,
        source_name: string
    ) => {
        for (const attribute of attributes ?? []) {
            const referenced_uuid = attribute?.role_instance_from?.uuid_has_reference_class_instance;
            if (referenced_uuid) {
                found.push({
                    source_uuid,
                    source_name,
                    attribute_uuid: attribute?.get_uuid?.() ?? attribute?.uuid,
                    referenced_uuid,
                });
            }
            walk(attribute?.table_attributes, source_uuid, source_name);
        }
    };

    for (const instance of [
        ...(scene?.class_instances ?? []),
        ...(scene?.relationclasses_instances ?? []),
    ]) {
        const uuid = instance?.get_uuid?.() ?? instance?.uuid;
        const name = instance?.get_name?.() ?? instance?.name ?? "";
        walk(instance?.attribute_instance, uuid, name);
        for (const port of instance?.port_instance ?? []) {
            walk(port?.attribute_instances, uuid, name);
        }
    }
    walk(scene?.attribute_instances, scene?.get_uuid?.() ?? scene?.uuid, scene?.get_name?.() ?? scene?.name ?? "");

    return found;
}

/**
 * @description - Refuses a scene whose references point at class instances that neither
 * the payload brings nor the database holds.
 *
 * WHY IT IS WORTH A QUERY. Such a reference reaches PostgreSQL as a foreign key
 * violation on `fk_role_instance_reference_class_instance`, which names a constraint and
 * nothing else: not the instance, not the attribute, not what is missing. The write is
 * lost either way — this only changes what the person on the other end is told, from a
 * constraint name to the model element they have to fix.
 * @param {PoolClient} client - The client to the database.
 * @param {SceneInstance} scene - The scene about to be written.
 * @throws {HTTP400Error} - If any reference cannot be resolved.
 */
export async function verify_class_references(client: PoolClient, scene: SceneInstance): Promise<void> {
    const references = class_references_of(scene);
    if (references.length === 0) return;

    const in_payload = class_instance_uuids_of(scene);
    const to_check = [...new Set(references.map((r) => r.referenced_uuid).filter((uuid) => !in_payload.has(uuid)))];
    if (to_check.length === 0) return;

    const existing = await client.query(
        "SELECT uuid_instance_object FROM class_instance WHERE uuid_instance_object = ANY($1::uuid[])",
        [to_check]
    );
    const in_database = new Set<string>(existing.rows.map((row) => row.uuid_instance_object));

    const dangling = references.filter(
        (reference) => !in_payload.has(reference.referenced_uuid) && !in_database.has(reference.referenced_uuid)
    );
    if (dangling.length === 0) return;

    // A handful is enough to act on; the rest are almost always the same cause.
    const shown = dangling
        .slice(0, 5)
        .map((d) => `"${d.source_name}" (${d.source_uuid}) refers to the missing class instance ${d.referenced_uuid}`)
        .join("; ");
    throw new HTTP400Error(
        `The scene ${scene?.get_uuid?.() ?? scene?.uuid} cannot be saved: ${dangling.length} reference(s) ` +
        `point at class instances that do not exist. ${shown}` +
        (dangling.length > 5 ? ` (and ${dangling.length - 5} more)` : "")
    );
}
