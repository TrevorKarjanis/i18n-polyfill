/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ml from "../ast/ast";
import * as i18n from "../ast/i18n_ast";
import * as xml from "./xml_helper";
import {I18nError} from "../ast/parse_util";
import {Parser} from "../ast/parser";
import {getXmlTagDefinition} from "../ast/xml_tags";
import {HtmlToXmlParser, I18nMessagesById, XmlMessagesById} from "./serializer";
import {digest} from "./digest";

const _VERSION = "1.2";
const _XMLNS = "urn:oasis:names:tc:xliff:document:1.2";
const _PLACEHOLDER_TAG = "x";
const _MARKER_TAG = 'mrk';
const _FILE_TAG = "file";
const _SOURCE_TAG = "source";
const _SEGMENT_SOURCE_TAG = 'seg-source';
const _TARGET_TAG = "target";
const _UNIT_TAG = "trans-unit";
const _CONTEXT_GROUP_TAG = "context-group";
const _CONTEXT_TAG = "context";
const _DEFAULT_SOURCE_LANG = "en";

export function xliffLoadToI18n(content: string): I18nMessagesById {
  // xliff to xml nodes
  const xliffParser = new XliffParser();
  const {msgIdToHtml, errors} = xliffParser.parse(content);

  // xml nodes to i18n messages
  const i18nMessagesById: {[msgId: string]: i18n.Node[]} = {};
  const converter = new XmlToI18n();

  Object.keys(msgIdToHtml).forEach(msgId => {
    const {i18nNodes, errors: e} = converter.convert(msgIdToHtml[msgId]);
    errors.push(...e);
    i18nMessagesById[msgId] = i18nNodes;
  });

  if (errors.length) {
    throw new Error(`xliff parse errors:\n${errors.join("\n")}`);
  }

  return i18nMessagesById;
}

// used to merge translations when extracting
export function xliffLoadToXml(content: string): XmlMessagesById {
  const parser = new HtmlToXmlParser(_UNIT_TAG);
  const {xmlMessagesById, errors} = parser.parse(content);

  if (errors.length) {
    throw new Error(`xliff parse errors:\n${errors.join("\n")}`);
  }

  return xmlMessagesById;
}

// http://docs.oasis-open.org/xliff/v1.2/os/xliff-core.html
// http://docs.oasis-open.org/xliff/v1.2/xliff-profile-html/xliff-profile-html-1.2.html
export function xliffWrite(messages: i18n.Message[], locale: string | null, existingNodes?: xml.Node[]): string {
  const visitor = new WriteVisitor();
  const transUnits: xml.Node[] = existingNodes && existingNodes.length ? [new xml.CR(6), ...existingNodes] : [];

  messages.forEach(message => {
    const contextTags: xml.Node[] = [];
    message.sources.forEach((source: i18n.MessageSpan) => {
      const contextGroupTag = new xml.Tag(_CONTEXT_GROUP_TAG, {purpose: "location"});
      contextGroupTag.children.push(
        new xml.CR(10),
        new xml.Tag(_CONTEXT_TAG, {"context-type": "sourcefile"}, [new xml.Text(source.filePath)]),
        new xml.CR(10),
        new xml.Tag(_CONTEXT_TAG, {"context-type": "linenumber"}, [new xml.Text(`${source.startLine}`)]),
        new xml.CR(8)
      );
      contextTags.push(new xml.CR(8), contextGroupTag);
    });

    const transUnit = new xml.Tag(_UNIT_TAG, {id: message.id, datatype: "html"});
    transUnit.children.push(
      new xml.CR(8),
      new xml.Tag(_SOURCE_TAG, {}, visitor.serialize(message.nodes)),
      ...contextTags
    );

    if (message.description) {
      transUnit.children.push(
        new xml.CR(8),
        new xml.Tag("note", {priority: "1", from: "description"}, [new xml.Text(message.description)])
      );
    }

    if (message.meaning) {
      transUnit.children.push(
        new xml.CR(8),
        new xml.Tag("note", {priority: "1", from: "meaning"}, [new xml.Text(message.meaning)])
      );
    }

    transUnit.children.push(new xml.CR(6));

    transUnits.push(new xml.CR(6), transUnit);
  });

  const body = new xml.Tag("body", {}, [...transUnits, new xml.CR(4)]);
  const file = new xml.Tag(
    "file",
    {
      "source-language": locale || _DEFAULT_SOURCE_LANG,
      datatype: "plaintext",
      original: "ng2.template"
    },
    [new xml.CR(4), body, new xml.CR(2)]
  );
  const xliff = new xml.Tag("xliff", {version: _VERSION, xmlns: _XMLNS}, [new xml.CR(2), file, new xml.CR()]);

  return xml.serialize([new xml.Declaration({version: "1.0", encoding: "UTF-8"}), new xml.CR(), xliff, new xml.CR()]);
}

export const xliffDigest = digest;

// Extract messages as xml nodes from the xliff file
class XliffParser implements ml.Visitor {
  private _unitMlString: string | null;
  private _errors: I18nError[];
  private _msgIdToHtml: {[msgId: string]: string};

  parse(content: string) {
    this._unitMlString = null;
    this._msgIdToHtml = {};

    const parser = new Parser(getXmlTagDefinition).parse(content, "", false);
    this._errors = parser.errors;
    ml.visitAll(this, parser.rootNodes, null);

    return {
      msgIdToHtml: this._msgIdToHtml,
      errors: this._errors
    };
  }

  visitElement(element: ml.Element, context: any): any {
    switch (element.name) {
      case _UNIT_TAG:
        this._unitMlString = null!;
        const idAttr = element.attrs.find(attr => attr.name === "id");
        if (!idAttr) {
          this._addError(element, `<${_UNIT_TAG}> misses the "id" attribute`);
        } else {
          const id = idAttr.value;
          if (this._msgIdToHtml.hasOwnProperty(id)) {
            this._addError(element, `Duplicated translations for msg ${id}`);
          } else {
            ml.visitAll(this, element.children, null);
            if (typeof this._unitMlString === "string") {
              this._msgIdToHtml[id] = this._unitMlString;
            } else {
              this._addError(element, `Message ${id} misses a translation`);
            }
          }
        }
        break;

      // ignore these tags
      case _SOURCE_TAG:
      case _SEGMENT_SOURCE_TAG:
        break;

      case _TARGET_TAG:
        const innerTextStart = element.startSourceSpan!.end.offset;
        const innerTextEnd = element.endSourceSpan!.start.offset;
        const content = element.startSourceSpan!.start.file.content;
        const innerText = content.slice(innerTextStart, innerTextEnd);
        this._unitMlString = innerText;
        break;

      case _FILE_TAG:
        ml.visitAll(this, element.children, null);
        break;

      default:
        // TODO(vicb): assert file structure, xliff version
        // For now only recurse on unhandled nodes
        ml.visitAll(this, element.children, null);
    }
  }

  visitAttribute(attribute: ml.Attribute, context: any): any {}

  visitText(text: ml.Text, context: any): any {}

  visitComment(comment: ml.Comment, context: any): any {}

  visitExpansion(expansion: ml.Expansion, context: any): any {}

  visitExpansionCase(expansionCase: ml.ExpansionCase, context: any): any {}

  private _addError(node: ml.Node, message: string): void {
    this._errors.push(new I18nError(node.sourceSpan!, message));
  }
}

// Convert ml nodes (xliff syntax) to i18n nodes
class XmlToI18n implements ml.Visitor {
  private _errors: I18nError[];

  convert(message: string) {
    const xmlIcu = new Parser(getXmlTagDefinition).parse(message, "", true);
    this._errors = xmlIcu.errors;

    const i18nNodes =
      this._errors.length > 0 || xmlIcu.rootNodes.length === 0 ?
        [] :
        [].concat(...ml.visitAll(this, xmlIcu.rootNodes));


    return {
      i18nNodes,
      errors: this._errors
    };
  }

  visitText(text: ml.Text, context: any) {
    return new i18n.Text(text.value, text.sourceSpan!);
  }

  visitElement(el: ml.Element, context: any): i18n.Placeholder | ml.Node[] | null {
    if (el.name === _PLACEHOLDER_TAG) {
      const nameAttr = el.attrs.find(attr => attr.name === "id");
      if (nameAttr) {
        return new i18n.Placeholder("", nameAttr.value, el.sourceSpan!);
      }

      this._addError(el, `<${_PLACEHOLDER_TAG}> misses the "id" attribute`);
      return null;
    }

    if (el.name === _MARKER_TAG) {
      return [].concat(...ml.visitAll(this, el.children));
    }

    this._addError(el, `Unexpected tag`);
    return null;
  }

  visitExpansion(icu: ml.Expansion, context: any) {
    const caseMap: {[value: string]: i18n.Node} = {};

    ml.visitAll(this, icu.cases).forEach((c: any) => {
      caseMap[c.value] = new i18n.Container(c.nodes, icu.sourceSpan);
    });

    return new i18n.Icu(icu.switchValue, icu.type, caseMap, icu.sourceSpan);
  }

  visitExpansionCase(icuCase: ml.ExpansionCase, context: any): any {
    return {
      value: icuCase.value,
      nodes: ml.visitAll(this, icuCase.expression)
    };
  }

  visitComment(comment: ml.Comment, context: any) {}

  visitAttribute(attribute: ml.Attribute, context: any) {}

  private _addError(node: ml.Node, message: string): void {
    this._errors.push(new I18nError(node.sourceSpan!, message));
  }
}

class WriteVisitor implements i18n.Visitor {
  visitText(text: i18n.Text, context?: any): xml.Node[] {
    return [new xml.Text(text.value)];
  }

  visitContainer(container: i18n.Container, context?: any): xml.Node[] {
    const nodes: xml.Node[] = [];
    container.children.forEach((node: i18n.Node) => nodes.push(...node.visit(this)));
    return nodes;
  }

  visitIcu(icu: i18n.Icu, context?: any): xml.Node[] {
    const nodes = [new xml.Text(`{${icu.expressionPlaceholder}, ${icu.type}, `)];

    Object.keys(icu.cases).forEach((c: string) => {
      nodes.push(new xml.Text(`${c} {`), ...icu.cases[c].visit(this), new xml.Text(`} `));
    });

    nodes.push(new xml.Text(`}`));

    return nodes;
  }

  visitTagPlaceholder(ph: i18n.TagPlaceholder, context?: any): xml.Node[] {
    const ctype = getCtypeForTag(ph.tag);

    if (ph.isVoid) {
      // void tags have no children nor closing tags
      return [new xml.Tag(_PLACEHOLDER_TAG, {id: ph.startName, ctype, "equiv-text": `<${ph.tag}/>`})];
    }

    const startTagPh = new xml.Tag(_PLACEHOLDER_TAG, {id: ph.startName, ctype, "equiv-text": `<${ph.tag}>`});
    const closeTagPh = new xml.Tag(_PLACEHOLDER_TAG, {id: ph.closeName, ctype, "equiv-text": `</${ph.tag}>`});

    return [startTagPh, ...this.serialize(ph.children), closeTagPh];
  }

  visitPlaceholder(ph: i18n.Placeholder, context?: any): xml.Node[] {
    return [new xml.Tag(_PLACEHOLDER_TAG, {id: ph.name, "equiv-text": `{{${ph.value}}}`})];
  }

  visitIcuPlaceholder(ph: i18n.IcuPlaceholder, context?: any): xml.Node[] {
    const equivText = `{${ph.value.expression}, ${ph.value.type}, ${Object.keys(ph.value.cases)
      .map((value: string) => value + " {...}")
      .join(" ")}}`;
    return [new xml.Tag(_PLACEHOLDER_TAG, {id: ph.name, "equiv-text": equivText})];
  }

  serialize(nodes: i18n.Node[]): xml.Node[] {
    return [].concat(...nodes.map(node => node.visit(this)));
  }
}

function getCtypeForTag(tag: string): string {
  switch (tag.toLowerCase()) {
    case "br":
      return "lb";
    case "img":
      return "image";
    default:
      return `x-${tag}`;
  }
}
