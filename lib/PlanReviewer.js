"use strict";

class PlanReviewer {

    constructor() {
        this.FS = require("fs");
        this.DEEPMERGE = require("deepmerge");
        this.DEEPEQUAL = require("deep-eql");
                       
        this.NO_CHANGES_OUTPUT = "No changes. Infrastructure is up-to-date.";
        this.KNOWN_AFTER_APPLY = "(known after apply)";
        this.CLOSE_RESOURCE = "}\n\n";

        this.CHANGE_MARKERS = {
            "READ": "<=",
            "CREATE": "+",
            "DELETE": "-",
            "UPDATE": "~",
            "UNKNOWN":"?"
        };

        this.CHANGES = {
            "READ": "read",
            "CREATE": "create",
            "UPDATE": "update",
            "DELETE": "delete",            
            "UNKNOWN": "unknown"
        };

        this.COLOR = {
            RED: "\x1b[31m",
            GREEN: "\x1b[32m",
            YELLOW: "\x1b[33m",
            RESET: "\x1b[0m",
            BLUE: "\x1b[34m"
        };
  
    }

    /**
     * Process the plan file
     * @param {*} planFile     
     * @memberof PlanReviewer
     */
    async process(planFile) {
        try {            
            if(!this.FS.existsSync(planFile)) throw new Error(`Plan file not found: ${planFile}`);
            let json = JSON.parse(this.FS.readFileSync(planFile));

            if(Array.isArray(json.resource_changes)) {
                console.log("\n");
                let changeCount = {
                    read: 0,
                    create: 0,
                    update: 0,
                    delete: 0,
                    unknown: 0
                };

                /*
                    iterate the changes listed in plan json and output changes
                        using simplified model
                */
                for(let i=0; i<json.resource_changes.length; i++) {
                    let resource = json.resource_changes[i];                    
                    let changeInfo = this.getResourceChangeInfo(resource.change.actions, changeCount);
                    if(changeInfo === null) continue; // no change to report
                    else {                        
                        let line = changeInfo.symbols.join("");  
                        line = line.trim();  
                        // single character w/ color will already have 10 total characters                    
                        line = line.padStart(11, " ");
                        if(resource.mode != "managed") {
                            line = `${line} ${resource.mode}`
                        }                        
                        line = `${line} "${resource.type}" "${resource.name}"  {`;
                        console.log(line);

                        // skip the details if only a delete is occuring
                        if(changeInfo.changes.length === 1 && changeInfo.changes[0] === this.CHANGES.DELETE) {
                            console.log(this.CLOSE_RESOURCE);
                            continue;
                        } 
                    }

                    /*
                        If resource action is only READ, then skip the details
                    */
                    if(changeInfo.changes.length === 1 && changeInfo.changes[0] === this.CHANGES.READ) {
                        console.log(this.CLOSE_RESOURCE);
                        continue;
                    }

                    /*
                        Iterate through the attributes of a single resource
                    */
                    let diffs = this.getAttributeDiffs(resource.change.after, resource.change.before, resource.change.after_unknown, resource);
                    let diffKeys = Object.keys(diffs);
                    for(let j=0; j<diffKeys.length; j++) {                        
                        let attribute = diffKeys[j];
                        let diff = diffs[attribute];
                        let line;
                        
                        /*
                            Certain (known after apply) attributes for select resources 
                            can be skipped to limit output to important changes
                        */
                        if(this.shouldSkipDiffKnownAfter(resource, diff, attribute) ||
                            this.shouldSkipAlways(resource, attribute)) continue;

                        if(this.DEEPEQUAL(diff.oldValue, diff.newValue)) continue; // skip line
                        else if(diff.oldValue !== null && diff.newValue === null) {                            
                            line =`\t${this.COLOR.RED}${this.CHANGE_MARKERS.DELETE}${this.COLOR.RESET}`;
                        }
                        else if(diff.oldValue === null && diff.newValue !== null) {
                            line = `\t${this.COLOR.GREEN}${this.CHANGE_MARKERS.CREATE}${this.COLOR.RESET}`;
                        }
                        else if(diff.oldValue !== diff.newValue) {
                            line = `\t${this.COLOR.YELLOW}${this.CHANGE_MARKERS.UPDATE}${this.COLOR.RESET}`;
                        }                        
                        
                        line = `${line} ${attribute}`;
                        line = line.padEnd(45, " ");
                        line = `${line}= `;
                        
                        // display old value if it exists
                        if(diff.oldValue !== null) {
                            /*
                                There are cases when diff.newValue will be (known after apply),
                                    but it probably should not changes because all variables are known.
                                    We need to make that complicated determination
                            */
                            let predictedNewValue = this.getPredictedNewValue(diff, resource, json);                            
                            if(diff.newValue === this.KNOWN_AFTER_APPLY && predictedNewValue !== null) {                                
                                try {
                                    if(diff.newValue === predictedNewValue || this.DEEPEQUAL(JSON.parse(diff.oldValue), JSON.parse(predictedNewValue))) {
                                        line = `${line} ${this.COLOR.YELLOW}->${this.COLOR.RESET} (Rendered - Predicting No Change)`;
                                        console.log(line);
                                        continue; // skip to next spec
                                    }
                                    // otherwise we will continue to next block which prints old value like always
                                }
                                catch(error) {
                                    console.log(`***Unexpected error comparing oldValue and new predictedValue`);
                                }                                
                            }

                            // output old value
                            switch(typeof diff.oldValue) {
                                case "string":
                                    line = `${line}"${diff.oldValue}"`;
                                    break;
                                case "object":
                                    if(Array.isArray(diff.oldValue) && diff.oldValue.length == 1) {
                                        line = `${line}${JSON.stringify(diff.oldValue[0], null, 4)}`;
                                    }
                                    else {
                                        line = `${line}${JSON.stringify(diff.oldValue, null, 4)}`;
                                    }                                    
                                    break;
                                default:
                                    line = `${line}${diff.oldValue}`;
                            }
                            line = `${line} ${this.COLOR.YELLOW}->${this.COLOR.RESET} `;
                        }

                        // always display new value
                        switch(typeof diff.newValue) {
                            case "string":
                                if(diff.newValue === this.KNOWN_AFTER_APPLY) {
                                    line = `${line}${this.KNOWN_AFTER_APPLY}`;
                                }
                                else {
                                    line = `${line}"${diff.newValue}"`;
                                }                                
                                break;
                            case "object":
                                /*
                                    Seems like this value will be array or json object;
                                    for array with single json object, we'll output the object w/o 
                                    the array wrapping it.  This is more similar to TF output.
                                */
                                if(Array.isArray(diff.newValue) && diff.newValue.length == 1 && 
                                    this.isObject(diff.newValue[0])) {
                                    line = `${line}${JSON.stringify(diff.newValue[0], null, 4)}`;
                                }
                                else {
                                    line = `${line}${JSON.stringify(diff.newValue, null, 4)}`;
                                }                                    
                                break;                          
                            default:
                                line = `${line}${diff.newValue}`;
                        }
                        console.log(`${line}`);                                        
                    }
                    console.log(this.CLOSE_RESOURCE);
                }

                // generate overall summary
                let changeSummary = `  Plan: ${this.COLOR.GREEN}${changeCount.create}${this.COLOR.RESET} to add`;
                changeSummary = `${changeSummary}, ${this.COLOR.YELLOW}${changeCount.update}${this.COLOR.RESET} to change`;
                changeSummary = `${changeSummary}, ${this.COLOR.RED}${changeCount.delete}${this.COLOR.RESET} to destroy.`;
                console.log(changeSummary);
                console.log("\n\n");
            }
            else {
                console.log(`${this.COLOR.GREEN}${this.NO_CHANGES_OUTPUT}${this.COLOR.RESET}`);
            }
          
        }  
        catch(error) {
            console.log(`Unexpected error: ${error}`);
            console.log(`Error stack: ${error.stack}`);
        }
    }

    /**
     * Situation where newValue is (known after apply) and before value is not null.
     * We need to perform complex evaluation to determine if we can "predict" that a change
     * will actually not take place
     *
     * @param {*} diff
     * @param {*} resource
     * @param {*} fullJson
     * @memberof PlanReviewer
     */
    getPredictedNewValue(diff, resource, fullJson) {
        /*
            Can only predict when new value is (known after apply) and resource
            is type aws_iam_role_policy with expression.policy.references[0] as data.template_file.x
        */       
       if(diff.newValue !== this.KNOWN_AFTER_APPLY || 
          !["aws_iam_role_policy", "aws_sfn_state_machine"].includes(resource.type)) return null;
       else {           
           let address = resource.address;                   
           // find this address in configuration.root_module.resources
           let configResourceWrapper = this.getConfigResourceWrapper(address, fullJson);
           if(configResourceWrapper === null) return null;
           let configResource = configResourceWrapper.resource;
           // look at policy/definition and see if it's dependent on a single data.template_file
           let dynamicAttribute;
           /*
                Is there an efficient way of doing this without knowing what attributes to be on the lookout for???
                Doing lookup logic for every single attributes with value (known after apply) severely degrade performance?
           */
           switch(resource.type) {
               case "aws_iam_role_policy":
                   dynamicAttribute = "policy";
                   break;
               case "aws_sfn_state_machine":
                   dynamicAttribute = "definition";
                   break;
               default:
                 throw new Error(`Unexpected resource type: [${resource.type}]`);
           }

           if(typeof configResource.expressions != "object" || 
             typeof configResource.expressions[dynamicAttribute] != "object" ||
            !Array.isArray(configResource.expressions[dynamicAttribute].references) || 
            configResource.expressions[dynamicAttribute].references.length != 1 ||
            !(configResource.expressions[dynamicAttribute].references[0].startsWith("data.template_file.") || configResource.expressions[dynamicAttribute].references[0].indexOf(".data.template_file.") > -1)) return null;                        
           
           let templateAddress = configResource.expressions[dynamicAttribute].references[0];                      
           /*
              Find the template file resource in planned_values attribute of fullJson
           */
           let templateResource = this.getPlannedValuesModuleResource(templateAddress, configResourceWrapper.moduleName, fullJson);
           if(templateResource == null) throw new Error(`Couldn't find template resource [${templateAddress}] in fullJson`);
           let template = templateResource.values.template;
           let templateVars = templateResource.values.vars;
           if(typeof template !== "string" || typeof templateVars !== "object") return null           
           /*
            splice all vars into the template to generate the predicted new value
           */
           let varKeys = Object.keys(templateVars);           
           for(let i=0; i<varKeys.length; i++) {
               let varKey = varKeys[i];
               let regex = new RegExp(`\\$\\{${varKey}\\}`, "gm");               
               template = template.replace(regex, templateVars[varKey]);
           }           
           return template;
       }
    }

    /**
     * Get the matching resource from planned_values attribute/section of full plan file
     *
     * @param {*} relativeAddress
     * @param {*} moduleName
     * @param {*} fullJson
     * @returns
     * @memberof PlanReviewer
     */
    getPlannedValuesModuleResource(relativeAddress, moduleName, fullJson) {
        /*
            The address passed in is a relative name and NOT
            fully qualified
        */        
        if(moduleName === "root_module") {
            // only search root module
            return this.getMatchingAddress(relativeAddress, fullJson.planned_values.root_module.resources);
        } 
        else {
            /*
                Look in matching child module first then root if still no match
            */               
            if(Array.isArray(fullJson.planned_values.root_module.child_modules)){
                for(let i=0; i<fullJson.planned_values.root_module.child_modules.length; i++) {
                    let childModule = fullJson.planned_values.root_module.child_modules[i];
                    if(childModule.address === `module.${moduleName}`) {
                        // search for fully qualified name
                        let resource = this.getMatchingAddress(`module.${moduleName}.${relativeAddress}`, childModule.resources);
                        if (resource !== null) return resource;                        
                        else break; // not in child modules specified by moduleName look in root module
                    }
                }                
            }
            // no matching template in the child module, lets check root
            return this.getMatchingAddress(fullAddress, fullJson.planned_values.root_module.resources);
        }         
    }

    /**
     * Certain resources with (known after apply) new values don't add much value
     *
     * @param {*} resource
     * @param {*} diff
     * @param {*} attribute
     * @memberof PlanReviewer
     */
    shouldSkipDiffKnownAfter(resource, diff, attribute) {        
        if(diff.newValue !== this.KNOWN_AFTER_APPLY) return false;
        else if(resource.type === "aws_lambda_function" && ["last_modified", "qualified_arn"].includes(attribute)) return true;        
        else return false;
    }

    /**
     * Indicates if outputter should skip this resource attribute
     *
     * @param {*} resource
     * @param {*} attribute
     * @returns
     * @memberof PlanReviewer
     */
    shouldSkipAlways(resource, attribute) {
        
        if(resource.type === "aws_lambda_function" && ["source_code_hash"].includes(attribute)) return true;        
        else return false;
    }

    /**
     * Gets the array item that matches the input address
     *
     * @param {*} address
     * @param {*} items
     * @memberof PlanReviewer
     */
    getMatchingAddress(address, items) {
        if(!Array.isArray(items)) throw new Error("items not array data type as expected.");
        for(let i=0; i<items.length; i++) {
            let item = items[i];
            if(item.address === address) return item;
        }
        // no match
        return null;
    }

    /**
     * Returns an object containing a resource and its moduleName
     *   from within the "configuration" attribute of plan JSON file.
     *
     * @param {*} fullAddress
     * @param {*} fullJson
     * @returns
     * @memberof PlanReviewer
     */
    getConfigResourceWrapper(fullAddress, fullJson) {
        let addressTokens = fullAddress.split(".");
        let tokenCount = addressTokens.length;
        let configResource;
        let moduleName;

        if(tokenCount <=2 ) {
            configResource = this.getMatchingAddress(fullAddress, fullJson.configuration.root_module.resources);
            moduleName = "root_module";
        }
        else {
            configResource = this.getMatchingAddress(`${addressTokens[tokenCount-2]}.${addressTokens[tokenCount-1]}`, fullJson.configuration.root_module.module_calls[addressTokens[tokenCount-3]].module.resources);
            moduleName = addressTokens[tokenCount-3];
        }

        if(configResource === undefined) {
            throw new Error(`Couldn't find change address [${fullAddress}] in plan JSON.`);
        } 
        else return {
            resource: configResource,
            moduleName: moduleName
        };
    }

    /**
     * Gets symbols to display for the resource's pending changes
     *
     * @param {*} actions
     * @param {object} changeCount
     * @memberof PlanReviewer
     */
    getResourceChangeInfo(actions, changeCount) {
        let changeInfo = {
            symbols: [],
            changes: []
        };
        let symbols = changeInfo.symbols;
        let changes = changeInfo.changes;
        if(actions.length === 1 && actions[0] === "no-op") return null;

        for(let i=0; i<actions.length; i++) {
            let action = actions[i];
            switch(action) {                
                case this.CHANGES.READ:
                    changeCount.read++;
                    symbols.push(`${this.COLOR.BLUE}${this.CHANGE_MARKERS.READ}${this.COLOR.RESET}`);
                    changes.push(this.CHANGES.READ);
                    break;
                case this.CHANGES.CREATE:
                    changeCount.create++;
                    symbols.push(`${this.COLOR.GREEN}${this.CHANGE_MARKERS.CREATE}${this.COLOR.RESET}`);
                    changes.push(this.CHANGES.CREATE);
                    break;
                case this.CHANGES.UPDATE:
                    changeCount.update++;
                    symbols.push(`${this.COLOR.YELLOW}${this.CHANGE_MARKERS.UPDATE}${this.COLOR.RESET}`);
                    changes.push(this.CHANGES.UPDATE);
                    break;
                case this.CHANGES.DELETE:
                    changeCount.delete++;
                    symbols.push(`${this.COLOR.RED}${this.CHANGE_MARKERS.DELETE}${this.COLOR.RESET}`);
                    changes.push(this.CHANGES.DELETE);
                    break;        
                default:
                    changeCount.unknown++;
                    symbols.push(`${this.COLOR.RED}${this.CHANGE_MARKERS.UNKNOWN}${this.COLOR.RESET}`);
                    changes.push(this.CHANGES.UNKNOWN);
            }
        }
        return changeInfo;
    }

    /**
     * Gets an object with attribute keys. Object contains property
     *      - oldValue
     *      - newValue     
     *
     * @param {*} newState
     * @param {*} oldState
     * @param {*} afterState
     * @param {object} resource
     * @memberof PlanReviewer
     */
    getAttributeDiffs(newState, oldState, afterState, resource) {
        /*
            oldState is known old resource attributes
            newState is known new state attributes
            afterState appears to be keys with boolean values
                indicating that the attribute state will only be known after apply
                but it is unknown what the nature of the value will be.
                Sometimes this value will be an empty array instead of boolean,
                or it will be an array with objects whose keys have an empty object value.
                e.g.
                "after_unknown": {
                    "dead_letter_config": [],
                    "environment": [
                        {
                            "variables": {}
                        }
                    ],
                    "last_modified": true,
                    "layers": [],
                    "qualified_arn": true,
                    "tags": {},
                    "timeouts": {},
                    "tracing_config": [
                        {}
                    ],
                    "version": true,
                    "vpc_config": []
                }
                It's unclear that the above really means.  Based on observation it is my guess
                    that boolean true simply means the entire value won't be known and it is of a very simple data type.
                    When the value is an object or array, we should merge this value when the known after value
                    (assuming that the 2 types can never be different from each other)
        */        
        let diffs = {};        
        
        /*
            Certain resources will have after properties that can effectively be ignored
        */
        if(resource.mode === "data" && resource.type === "template_file") {
            delete afterState.id;
            delete afterState.rendered;
        }

        let oldKeys = (oldState === null || oldState === undefined) ? [] : Object.keys(oldState);
        let newKeys = (newState === null || newState === undefined) ? [] : Object.keys(newState);
        let afterKeys = Object.keys(afterState);        

        // combine the keys w/o duplicates
        for(let i=0; i<oldKeys.length; i++) {
            let key = oldKeys[i];
            diffs[key] = null;
        }
        for(let i=0; i<newKeys.length; i++) {
            let key = newKeys[i];
            diffs[key] = null;
        }
        for(let i=0; i<afterKeys.length; i++) {
            let key = afterKeys[i];
            diffs[key] = null;
        }

        // iterate the combined keys and get a simplified model of diff
        let allKeys = Object.keys(diffs);
        for(let i=0; i<allKeys.length; i++) {
            let key = allKeys[i];            
            diffs[key] = {}; 

            if(oldState == null ||
               oldState[key] === undefined || 
               oldState[key] === null ||
               this.isEmptyObject(oldState[key])
            ) {
                diffs[key].oldValue = null;
            }
            else {
                diffs[key].oldValue = oldState[key];
            }

            if(newState === null ||
                newState[key] === undefined || 
                newState[key] === null ||
                this.isEmptyObject(newState[key])
            ) {
                 diffs[key].newValue = null;
            }
            else {
                diffs[key].newValue = newState[key];
            }

            /*
                Complete newValue by merging in (known after apply) values if necessary.
            */
            if(afterState[key] !== undefined && 
                afterState[key] !== null &&
                !this.isEmptyObject(afterState[key])
            ) {
                // check simple boolean
                if(afterState[key] === true) {
                    // take over the value
                    diffs[key].newValue = this.KNOWN_AFTER_APPLY;
                }
                else if(afterState[key] === false) {
                    // no merging reconcilliation needed
                    continue;
                }
                else if(diffs[key].newValue === null) {
                    // take over value
                    diffs[key].newValue = afterState[key];
                }                
                else if(Array.isArray(afterState[key]) && Array.isArray(diffs[key].newValue)) {
                    /*
                        through observation, it seems like we should only be expecting objects
                        as elements of both arrays and we need to merge the attributes of the objects
                    */  
                    let combinedItems = [];
                    for(let j=0; j<Math.max(afterState[key].length, diffs[key].newValue.length); j++) {
                        let newItem = (diffs[key].newValue[j] === undefined) ? {} : diffs[key].newValue[j];
                        let afterItem = (afterState[key][j] === undefined) ? {} : afterState[key][j];
                        // deep merge these two objects
                        if(["string", "number", "boolean"].includes(typeof afterItem)) {
                            // take over the value entirely for this index item
                            if(afterItem === false && newItem !== null) {
                                // don't merge this index item
                                combinedItems.push(newItem);
                            }
                            else {
                                combinedItems.push(afterItem);
                            }
                            
                        }
                        else {
                            // merge for this index item
                            let combined = this.DEEPMERGE(newItem, afterItem);
                            combinedItems.push(combined);
                        }                        
                    }
                    // sets complete new array value for this particular attribute
                    diffs[key].newValue = combinedItems;
                }
                else if(this.isObject(afterState[key]) && this.isObject(diffs[key].newValue)) {
                    // attribute values are objects that need merging
                    diffs[key].newValue = this.DEEPMERGE(diffs[key].newValue, afterState[key]);
                }
                else {
                    // not sure this would ever occur
                    console.log(`Unexpected condition after attribute [${key}] value [${diffs[key].newValue}]; after_unknown value [${afterState[key]}]`);
                }                 
            }            
        }
        
        return diffs;
    }

    /**
     * Customized method that excludes array
     *
     * @param {*} x
     * @returns
     * @memberof PlanReviewer
     */
    isObject(x) {
        return (typeof x == "object" && !Array.isArray(x));
    }

    /**
     * Indicates if reference is empty json object
     *
     * @param {*} x
     * @returns
     * @memberof PlanReviewer
     */
    isEmptyObject(x) {
        return (this.isObject(x) && Object.keys(x).length === 0);
    }

}

module.exports = PlanReviewer;