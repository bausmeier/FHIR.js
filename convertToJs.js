var convert = require('xml-js');
var _ = require('underscore');
var ParseConformance = require('./parseConformance.js');

/**
 * @constructor
 * @param {ParseConformance} [parser] A parser, which may include specialized StructureDefintion and ValueSet resources
 */
function ConvertToJS(parser) {
    this.parser = parser || new ParseConformance(true);
}

/**
 * Converts the specified XML resource to a JS object, storing arbitrary-length decimals as strings since FHIR spec requires arbitrary precision.
 * @param {string} xml Resource XML string
 * @returns {FHIR.Resource} A Resource object converted from the XML Resource. Decimals stored as strings.
 */
ConvertToJS.prototype.convert = function(xml) {
    var self = this;
    var xmlObj = convert.xml2js(xml);

    if (xmlObj.elements.length === 1) {
        return self.resourceToJS(xmlObj.elements[0], null);
    }
};

/**
 * Converts the specified XML resource to JSON,
 * turning arbitrary-length decimals into JSON numbers as per the FHIR spec.
 * @param {string} xml Resource XML string
 * @returns {string} JSON with Numbers potentially too large for normal JavaScript & JSON.parse
 */
ConvertToJS.prototype.convertToJSON = function(xml) {
    var self = this;
    var xmlObj = convert.xml2js(xml);
    if (xmlObj.elements.length !== 1) {
        return
    }

    /* Decimals are converted into an object with a custom
    toJSON function that wraps them with 'DDDD's of a length
    greater than any length of Ds in the JSON */
    var surroundDecimalsWith = {};
    var jsObj = self.resourceToJS(xmlObj.elements[0], surroundDecimalsWith);
    var maxDLength = self.maxLengthOfDs(jsObj);
    var rpt = '';
    for (var i = 0; i < maxDLength + 5; i++) {
      rpt += 'D';
    }
    surroundDecimalsWith.str = rpt;
    var json = JSON.stringify(jsObj, null, '\t');

    var replaceRegex = new RegExp('"?' + surroundDecimalsWith.str + '"?', 'g');
    // console.log("replaceRegex", replaceRegex)
    var json2 = json.replace(replaceRegex, '');
    return json2
};

ConvertToJS.prototype.maxLengthOfDs = function(obj) {
    /**
     * get length of longest sequence of 'D' characters in a string
     * @param {string} str
    */
    function maxSubstringLengthStr(str) {
        var matches = str.match(/DDDD+/g);
        if (!matches) {
            return 0;
        }
        var ret = matches
                .map(function(substr) { return substr.length })
                .reduce(function(p,c) { return Math.max(p,c)}, 0);
        return ret;
    }
    /**
     * look through object to find longest sequence of 'D' characters
     * so we can safely wrap decimals
    */
    function maxSubstringLength(currentMax, obj) {
        var ret;
        if (typeof(obj) === 'string') {
            ret =  Math.max(currentMax, maxSubstringLengthStr(obj));
        } else if (typeof(obj) === 'object') {
            ret =  Object.keys(obj)
                    .map(function(k) {
                        return Math.max(maxSubstringLengthStr(k), maxSubstringLength(currentMax, obj[k]))
                    })
                    .reduce(function(p,c) { return Math.max(p,c) }, currentMax);
        } else {
            ret =  currentMax;
        }
        return ret;
    }
    return maxSubstringLength(0, obj);
}

/**
 * @param xmlObj
 * @returns {*}
 * @private
 */
ConvertToJS.prototype.resourceToJS = function(xmlObj, surroundDecimalsWith) {
    var self = this;
    var typeDefinition = self.parser.parsedStructureDefinitions[xmlObj.name];
    var self = this;
    var resource = {
        resourceType: xmlObj.name
    };

    if (!typeDefinition) {
        throw new Error('Unknown resource type: ' + xmlObj.name);
    }

    _.each(typeDefinition._properties, function(property) {
        self.propertyToJS(xmlObj, resource, property, surroundDecimalsWith);
    });

    return resource;
}

/**
 * Finds a property definition based on a reference to another type. Should be a BackboneElement
 * @param relativeType {string} Example: "#QuestionnaireResponse.item"
 */
ConvertToJS.prototype.findReferenceType = function(relativeType) {
    if (!relativeType || !relativeType.startsWith('#')) {
        return;
    }

    var resourceType = relativeType.substring(1, relativeType.indexOf('.'));        // Assume starts with #
    var path = relativeType.substring(resourceType.length + 2);
    var resourceDefinition = this.parser.parsedStructureDefinitions[resourceType];
    var pathSplit = path.split('.');

    if (!resourceDefinition) {
        throw new Error('Could not find resource definition for ' + resourceType);
    }

    var current = resourceDefinition;
    for (var i = 0; i < pathSplit.length; i++) {
        var nextPath = pathSplit[i];
        current = _.find(current._properties, function(property) {
            return property._name === nextPath;
        });

        if (!current) {
            return;
        }
    }

    return current;
}

/**
 * @param xmlObj
 * @param obj
 * @param property
 * @private
 */
ConvertToJS.prototype.propertyToJS = function(xmlObj, obj, property, surroundDecimalsWith) {
    var self = this;
    var xmlProperty = _.filter(xmlObj.elements, function(element) {
        return element.name === property._name;
    });

    if (!xmlProperty || xmlProperty.length === 0) {
        return;
    }

    // If this is a reference type then f
    if (property._type.startsWith('#')) {
        var relativeType = this.findReferenceType(property._type);

        if (!relativeType) {
            throw new Error('Could not find reference to element definition ' + relativeType);
        }

        property = relativeType;
    }

    function pushValue(value) {
        if (!value) return;

        switch (property._type) {
            case 'string':
            case 'base64Binary':
            case 'code':
            case 'id':
            case 'markdown':
            case 'uri':
            case 'oid':
            case 'date':
            case 'dateTime':
            case 'time':
            case 'instant':
                if (value.attributes['value']) {
                    if (obj[property._name] instanceof Array) {
                        obj[property._name].push(value.attributes['value'])
                    } else {
                        obj[property._name] = value.attributes['value'];
                    }
                }
                break;
            case 'decimal':
                if (value.attributes['value']) {
                    if (obj[property._name] instanceof Array) {
                        obj[property._name].push(convertDecimal(value.attributes['value'], surroundDecimalsWith))
                    } else {
                        obj[property._name] = convertDecimal(value.attributes['value'], surroundDecimalsWith)
                    }
                }
                break;
            case 'boolean':
                if (value.attributes['value']) {
                    if (obj[property._name] instanceof Array) {
                        obj[property._name].push(toBoolean(value.attributes['value']))
                    } else {
                        obj[property._name] = toBoolean(value.attributes['value'])
                    }
                }
                break;
            case 'integer':
            case 'unsignedInt':
            case 'positiveInt':
                if (value.attributes['value']) {
                    if (obj[property._name] instanceof Array) {
                        obj[property._name].push(toNumber(value.attributes['value']))
                    } else {
                        obj[property._name] = toNumber(value.attributes['value'])
                    }
                }
                break;
            case 'xhtml':
                if (value.elements && value.elements.length > 0) {
                    var div = convert.js2xml({elements: [value]});
                    if (obj[property._name] instanceof Array) {
                        obj[property._name].push(div);
                    } else {
                        obj[property._name] = div;
                    }
                }
                break;
            case 'BackboneElement':
                var newValue = {};

                for (var x in property._properties) {
                    var nextProperty = property._properties[x];
                    self.propertyToJS(value, newValue, nextProperty, surroundDecimalsWith);
                }

                if (obj[property._name] instanceof Array) {
                    obj[property._name].push(newValue);
                } else {
                    obj[property._name] = newValue;
                }
                break;
            case 'Resource':
                if (value.elements.length === 1) {
                    if (obj[property._name] instanceof Array) {
                        obj[property._name].push(self.resourceToJS(value.elements[0], surroundDecimalsWith))
                    } else {
                        obj[property._name] = self.resourceToJS(value.elements[0], surroundDecimalsWith);
                    }
                }
                break;
            default:
                var nextType = self.parser.parsedStructureDefinitions[property._type];

                if (!nextType) {
                    console.log('do something');
                } else {
                    var newValue = {};

                    _.each(nextType._properties, function(nextProperty) {
                        self.propertyToJS(value, newValue, nextProperty, surroundDecimalsWith);
                    });

                    if (obj[property._name] instanceof Array) {
                        obj[property._name].push(newValue);
                    } else {
                        obj[property._name] = newValue;
                    }
                }
                break;
        }
    }
    function toBoolean(value) {
        if (value === "true") {
            return true;
        } else if (value === "false") {
            return false;
        } else {
            throw new Error("value supposed to be a boolean but got: " + value)
        }
    }
    function toNumber(value) {
        if (/^-?\d+$/.test(value) == false) {
            throw new Error("value supposed to be a number but got: " + value)
        }
        return parseInt(value, 10)
    }
    function convertDecimal(value, surroundDecimalsWith) {
        // validation regex from http://hl7.org/fhir/xml.html
        if (/^-?([0]|([1-9][0-9]*))(\.[0-9]+)?$/.test(value) == false) {
            throw new Error("value supposed to be a decimal number but got: " + value)
        }
        if (surroundDecimalsWith) {
            return {
                value: value,
                toJSON() {
                    // surrounding str used as a marker to remove quotes to turn this
                    // into a JSON number as per FHIR spec..
                    return surroundDecimalsWith.str + value + surroundDecimalsWith.str;
                }
            }
        } else {
            return value;
        }
    }

    if (property._multiple) {
        obj[property._name] = [];
    }

    for (var i in xmlProperty) {
        pushValue(xmlProperty[i]);
    }
}

module.exports = ConvertToJS;