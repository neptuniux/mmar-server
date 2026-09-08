import chai from "chai";
import "mocha";
import {ClassInstance} from "../../../mmar-global-data-structure";
import {
    referenced_class_instances_of,
    sort_class_instances_by_reference,
} from "../../data/services/instance_reference_order";

const expect = chai.expect;

/**
 * @description - Ordering a batch of class instances so their references point backwards.
 *
 * A class instance is written together with its attributes, and a reference attribute's
 * role instance is a foreign key onto `class_instance`. A payload that lists a Joint
 * before the Link it points at therefore used to fail the whole scene PATCH with
 * `fk_role_instance_reference_class_instance` — a constraint name, telling the user
 * nothing about the model they were trying to save.
 *
 * No database here: this is the pure ordering, and it is the part that has to be right.
 */

/** A class instance whose reference attribute points at `referencesUuid`. */
function instance(uuid: string, referencesUuid?: string, tableReferenceUuid?: string): ClassInstance {
    return ClassInstance.fromJS({
        uuid,
        name: uuid,
        uuid_class: "some-class",
        attribute_instance: [
            {
                uuid: `${uuid}-plain`,
                uuid_attribute: "plain-attribute",
                value: "no reference here",
            },
            {
                uuid: `${uuid}-ref`,
                uuid_attribute: "reference-attribute",
                value: "",
                role_instance_from: referencesUuid
                    ? {uuid: `${uuid}-role`, uuid_has_reference_class_instance: referencesUuid}
                    : undefined,
                table_attributes: tableReferenceUuid
                    ? [
                          {
                              uuid: `${uuid}-cell`,
                              uuid_attribute: "cell-attribute",
                              value: "",
                              role_instance_from: {
                                  uuid: `${uuid}-cell-role`,
                                  uuid_has_reference_class_instance: tableReferenceUuid,
                              },
                          },
                      ]
                    : undefined,
            },
        ],
    }) as ClassInstance;
}

const uuidsOf = (instances: ClassInstance[]) => instances.map((i) => i.get_uuid());

describe("Class instance reference ordering", function () {
    describe("referenced_class_instances_of", function () {
        it("collects a reference attribute's target", function () {
            expect([...referenced_class_instances_of(instance("joint", "link"))]).to.deep.equal(["link"]);
        });

        // A table cell is an attribute instance in its own right and can reference too.
        it("collects a reference held in a table column", function () {
            const found = referenced_class_instances_of(instance("joint", "link", "other-link"));
            expect([...found].sort()).to.deep.equal(["link", "other-link"]);
        });

        it("finds nothing on an instance that references nothing", function () {
            expect([...referenced_class_instances_of(instance("link"))]).to.deep.equal([]);
        });
    });

    describe("sort_class_instances_by_reference", function () {
        // THE FAILING PAYLOAD: a URDF import's Joint carries "Parent link" / "Child link"
        // pointing at Links of the same scene. Sent Joint-first, the Link row did not
        // exist when the role instance was written.
        it("writes a referenced instance before the one that references it", function () {
            const ordered = sort_class_instances_by_reference([
                instance("joint", "link"),
                instance("link"),
            ]);

            expect(uuidsOf(ordered)).to.deep.equal(["link", "joint"]);
        });

        it("leaves an order that already works exactly as it was", function () {
            const ordered = sort_class_instances_by_reference([
                instance("link"),
                instance("joint", "link"),
                instance("unrelated"),
            ]);

            expect(uuidsOf(ordered)).to.deep.equal(["link", "joint", "unrelated"]);
        });

        it("follows a chain of references all the way down", function () {
            const ordered = sort_class_instances_by_reference([
                instance("third", "second"),
                instance("second", "first"),
                instance("first"),
            ]);

            expect(uuidsOf(ordered)).to.deep.equal(["first", "second", "third"]);
        });

        it("orders a reference held in a table column too", function () {
            const ordered = sort_class_instances_by_reference([
                instance("joint", undefined, "link"),
                instance("link"),
            ]);

            expect(uuidsOf(ordered)).to.deep.equal(["link", "joint"]);
        });

        // Anything not in this batch either exists already or is dangling; the database
        // is the one to answer for it, and ordering must not drop the instance.
        it("keeps an instance whose reference is not part of the batch", function () {
            const ordered = sort_class_instances_by_reference([
                instance("joint", "a-link-saved-last-week"),
                instance("link"),
            ]);

            expect(uuidsOf(ordered)).to.deep.equal(["joint", "link"]);
        });

        // Two instances referencing each other cannot both be written second, so no
        // order saves them and this does not pretend otherwise: the batch still fails on
        // the same constraint. What must hold is that the cycle neither loses anyone nor
        // disturbs the instances around it.
        it("survives a cycle without dropping it, or the batch around it", function () {
            const ordered = sort_class_instances_by_reference([
                instance("cycle-a", "cycle-b"),
                instance("cycle-b", "cycle-a"),
                instance("joint", "link"),
                instance("link"),
            ]);

            expect(uuidsOf(ordered).sort()).to.deep.equal(["cycle-a", "cycle-b", "joint", "link"]);
            expect(uuidsOf(ordered).indexOf("link")).to.be.lessThan(uuidsOf(ordered).indexOf("joint"));
        });

        it("returns a short batch untouched", function () {
            const one = [instance("only")];
            expect(sort_class_instances_by_reference(one)).to.equal(one);
            expect(sort_class_instances_by_reference([])).to.deep.equal([]);
        });

        it("loses nothing, whatever the batch holds", function () {
            const batch = [
                instance("joint-1", "link-2"),
                instance("link-1"),
                instance("joint-2", "link-1"),
                instance("link-2"),
            ];

            const ordered = sort_class_instances_by_reference(batch);

            expect(ordered).to.have.lengthOf(batch.length);
            expect(uuidsOf(ordered).sort()).to.deep.equal(["joint-1", "joint-2", "link-1", "link-2"]);
            // Every reference now points backwards.
            const seen = new Set<string>();
            for (const current of ordered) {
                for (const referenced of referenced_class_instances_of(current)) {
                    expect(seen.has(referenced), `${current.get_uuid()} -> ${referenced}`).to.equal(true);
                }
                seen.add(current.get_uuid());
            }
        });
    });
});
