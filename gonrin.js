(function(root, factory) {

	if (typeof exports !== 'undefined') {
		// Define as CommonJS export:
		module.exports = factory(require("underscore"), require("backbone"));
	} else if (typeof define === 'function' && define.amd) {
		// Define as AMD:
		define(["underscore", "backbone"], factory);
	} else {
		// Just run it:
		factory(root._, root.Backbone);
	}

}(this, function(_, Backbone) {
	
	var extend = function(protoProps, staticProps) {
		var parent = this;
		var child;

		// The constructor function for the new subclass is either defined by you
		// (the "constructor" property in your `extend` definition), or defaulted
		// by us to simply call the parent constructor.
		if (protoProps && _.has(protoProps, 'constructor')) {
			child = protoProps.constructor;
		} else {
			child = function(){ return parent.apply(this, arguments); };
		}

		// Add static properties to the constructor function, if supplied.
		_.extend(child, parent, staticProps);

		// Set the prototype chain to inherit from `parent`, without calling
		// `parent` constructor function.
		var Surrogate = function(){ this.constructor = child; };
		Surrogate.prototype = parent.prototype;
		child.prototype = new Surrogate;

		// Add prototype properties (instance properties) to the subclass,
		// if supplied.
		if (protoProps) _.extend(child.prototype, protoProps);

		// Set a convenience property in case the parent's prototype is needed
		// later.
		child.__super__ = parent.prototype;

		return child;
	};



	// Gonrin namespace:
	var Gonrin = Backbone.Gonrin = {};

	// Object-type utils:
	var array = Array.prototype;
	var isUndefined = _.isUndefined;
	var isFunction = _.isFunction;
	var isObject = _.isObject;
	var isArray = _.isArray;
	var isModel = function(obj) { return obj instanceof Backbone.Model; };
	var isCollection = function(obj) { return obj instanceof Backbone.Collection; };
	var blankMethod = function() {};
	
	// Determine if `el` is a child of the document
	Gonrin.isNodeAttached = function(el) {
	    return Backbone.$.contains(document.documentElement, el);
	};

	// Static mixins API:
	// added as a static member to Gonrin class objects (Model & View);
	// generates a set of class attributes for mixin with other objects.
	var mixins = {
			mixin: function(extend) {
				extend = extend || {};

				for (var i in this.prototype) {
					// Skip override on pre-defined binding declarations:
					if (i === 'bindings' && extend.bindings) continue;

					// Assimilate non-constructor Gonrin prototype properties onto extended object:
					if (this.prototype.hasOwnProperty(i) && i !== 'constructor') {
						extend[i] = this.prototype[i];
					}
				}
				return extend;
			}
	};

	// Calls method implementations of a super-class object:
	function _super(instance, method, args) {
		return instance._super.prototype[method].apply(instance, args);
	}
	
	
	//Gonrin.Events
	Gonrin.Events = Backbone.Events;

	var modelMap;
	var modelProps = ['computeds', 'modelData'];

	Gonrin.Model = Backbone.Model.extend({
		_super: Backbone.Model,
		// Backbone.Model constructor override:
		// configures computed model attributes around the underlying native Backbone model.
		constructor: function(attributes, options) {
			_.extend(this, _.pick(options||{}, modelProps));
			_super(this, 'constructor', arguments);
			this.initComputeds(attributes, options);
		},
		modelData: {},

		// Gets a copy of a model attribute value:
		// Array and Object values will return a shallow copy,
		// primitive values will be returned directly.
		getCopy: function(attribute) {
			return _.clone(this.get(attribute));
		},

		// Backbone.Model.get() override:
		// provides access to computed attributes,
		// and maps computed dependency references while establishing bindings.
		get: function(attribute) {

			// Automatically register bindings while building out computed dependency graphs:
			modelMap && modelMap.push(['change:'+attribute, this]);

			// Return a computed property value, if available:
			if (this.hasComputed(attribute)) {
				return this.c()[ attribute ].get();
			}

			// Default to native Backbone.Model get operation:
			return _super(this, 'get', arguments);
		},

		// Backbone.Model.set() override:
		// will process any computed attribute setters,
		// and then pass along all results to the underlying model.
		set: function(key, value, options) {
			var params = key;

			// Convert key/value arguments into {key:value} format:
			if (params && !isObject(params)) {
				params = {};
				params[ key ] = value;
			} else {
				options = value;
			}

			// Default options definition:
			options = options || {};

			// Create store for capturing computed change events:
			var computedEvents = this._setting = [];

			// Attempt to set computed attributes while not unsetting:
			if (!options.unset) {
				// All param properties are tested against computed setters,
				// properties set to computeds will be removed from the params table.
				// Optionally, an computed setter may return key/value pairs to be merged into the set.
				params = deepModelSet(this, params, {}, []);
			}

			// Remove computed change events store:
			delete this._setting;

			// Pass all resulting set params along to the underlying Backbone Model.
			var result = _super(this, 'set', [params, options]);

			// Dispatch all outstanding computed events:
			if (!options.silent) {
				// Make sure computeds get a "change" event:
				if (!this.hasChanged() && computedEvents.length) {
					this.trigger('change', this);
				}

				// Trigger each individual computed attribute change:
				// NOTE: computeds now officially fire AFTER basic "change"...
				// We can't really fire them earlier without duplicating the Backbone "set" method here.
				_.each(computedEvents, function(evt) {
					this.trigger.apply(this, evt);
				}, this);
			}
			return result;
		},

		// Backbone.Model.toJSON() override:
		// adds a 'computed' option, specifying to include computed attributes.
		toJSON: function(options) {
			var json = _super(this, 'toJSON', arguments);

			if (options && options.computed) {
				_.each(this.c(), function(computed, attribute) {
					json[ attribute ] = computed.value;
				});
			}

			return json;
		},

		// Backbone.Model.destroy() override:
		// clears all computed attributes before destroying.
		destroy: function() {
			this.clearComputeds();
			return _super(this, 'destroy', arguments);
		},

		// Computed namespace manager:
		// Allows the model to operate as a mixin.
		c: function() {
			return this._c || (this._c = {});
		},
		// Initializes the Gonrin model:
		// called automatically by the native constructor,
		// or may be called manually when adding Gonrin as a mixin.
		initComputeds: function(attributes, options) {
			this.clearComputeds();

			// Resolve computeds hash, and extend it with any preset attribute keys:
			// TODO: write test.
			var computeds = _.result(this, 'computeds')||{};
			computeds = _.extend(computeds, _.pick(attributes||{}, _.keys(computeds)));

			// Add all computed attributes:
			_.each(computeds, function(params, attribute) {
				params._init = 1;
				this.addComputed(attribute, params);
			}, this);

			// Initialize all computed attributes:
			// all presets have been constructed and may reference each other now.
			_.invoke(this.c(), 'init');
		},

		// Adds a computed attribute to the model:
		// computed attribute will assemble and return customized values.
		// @param attribute (string)
		// @param getter (function) OR params (object)
		// @param [setter (function)]
		// @param [dependencies ...]
		addComputed: function(attribute, getter, setter) {
			this.removeComputed(attribute);

			var params = getter;
			var delayInit = params._init;

			// Test if getter and/or setter are provided:
			if (isFunction(getter)) {
				var depsIndex = 2;

				// Add getter param:
				params = {};
				params._get = getter;

				// Test for setter param:
				if (isFunction(setter)) {
					params._set = setter;
					depsIndex++;
				}

				// Collect all additional arguments as dependency definitions:
				params.deps = array.slice.call(arguments, depsIndex);
			}

			// Create a new computed attribute:
			this.c()[ attribute ] = new GonrinComputedModel(this, attribute, params, delayInit);
			return this;
		},

		// Tests the model for a computed attribute definition:
		hasComputed: function(attribute) {
			return this.c().hasOwnProperty(attribute);
		},

		// Removes an computed attribute from the model:
		removeComputed: function(attribute) {
			if (this.hasComputed(attribute)) {
				this.c()[ attribute ].dispose();
				delete this.c()[ attribute ];
			}
			return this;
		},

		// Removes all computed attributes:
		clearComputeds: function() {
			for (var attribute in this.c()) {
				this.removeComputed(attribute);
			}
			return this;
		},

		// Internal array value modifier:
		// performs array ops on a stored array value, then fires change.
		// No action is taken if the specified attribute value is not an array.
		modifyArray: function(attribute, method, options) {
			var obj = this.get(attribute);

			if (isArray(obj) && isFunction(array[method])) {
				var args = array.slice.call(arguments, 2);
				var result = array[ method ].apply(obj, args);
				options = options || {};

				if (!options.silent) {
					this.trigger('change:'+attribute+' change', this, array, options);
				}
				return result;
			}
			return null;
		},

		// Internal object value modifier:
		// sets new property values on a stored object value, then fires change.
		// No action is taken if the specified attribute value is not an object.
		modifyObject: function(attribute, property, value, options) {
			var obj = this.get(attribute);
			var change = false;

			// If property is Object:
			if (isObject(obj)) {

				options = options || {};

				// Delete existing property in response to undefined values:
				if (isUndefined(value) && obj.hasOwnProperty(property)) {
					delete obj[property];
					change = true;
				}
				// Set new and/or changed property values:
				else if (obj[ property ] !== value) {
					obj[ property ] = value;
					change = true;
				}

				// Trigger model change:
				if (change && !options.silent) {
					this.trigger('change:'+attribute+' change', this, obj, options);
				}

				// Return the modified object:
				return obj;
			}
			return null;
		}
	}, mixins);

	// Gonrin.Model -> Private
	// ----------------------

	// Model deep-setter:
	// Attempts to set a collection of key/value attribute pairs to computed attributes.
	// Observable setters may digest values, and then return mutated key/value pairs for inclusion into the set operation.
	// Values returned from computed setters will be recursively deep-set, allowing computeds to set other computeds.
	// The final collection of resolved key/value pairs (after setting all computeds) will be returned to the native model.
	// @param model: target Gonrin model on which to operate.
	// @param toSet: an object of key/value pairs to attempt to set within the computed model.
	// @param toReturn: resolved non-ovservable attribute values to be returned back to the native model.
	// @param trace: property stack trace (prevents circular setter loops).
	function deepModelSet(model, toSet, toReturn, stack) {

		// Loop through all setter properties:
		for (var attribute in toSet) {
			if (toSet.hasOwnProperty(attribute)) {

				// Pull each setter value:
				var value = toSet[ attribute ];

				if (model.hasComputed(attribute)) {

					// Has a computed attribute:
					// comfirm attribute does not already exist within the stack trace.
					if (!stack.length || !_.contains(stack, attribute)) {

						// Non-recursive:
						// set and collect value from computed attribute.
						value = model.c()[attribute].set(value);

						// Recursively set new values for a returned params object:
						// creates a new copy of the stack trace for each new search branch.
						if (value && isObject(value)) {
							toReturn = deepModelSet(model, value, toReturn, stack.concat(attribute));
						}

					} else {
						// Recursive:
						// Throw circular reference error.
						throw('Recursive setter: '+stack.join(' > '));
					}
				} else {
					// No computed attribute:
					// set the value to the keeper values.
					toReturn[ attribute ] = value;
				}
			}
		}

		return toReturn;
	}


	// Gonrin.Model -> Computed
	// -----------------------
	// Computed objects store model values independently from the model's attributes table.
	// Computeds define custom getter/setter functions to manage their value.

	function GonrinComputedModel(model, name, params, delayInit) {
		params = params || {};

		// Rewrite getter param:
		if (params.get && isFunction(params.get)) {
			params._get = params.get;
		}

		// Rewrite setter param:
		if (params.set && isFunction(params.set)) {
			params._set = params.set;
		}

		// Prohibit override of 'get()' and 'set()', then extend:
		delete params.get;
		delete params.set;
		_.extend(this, params);

		// Set model, name, and default dependencies array:
		this.model = model;
		this.name = name;
		this.deps = this.deps || [];

		// Skip init while parent model is initializing:
		// Model will initialize in two passes...
		// the first pass sets up all computed attributes,
		// then the second pass initializes all bindings.
		if (!delayInit) this.init();
	}

	_.extend(GonrinComputedModel.prototype, Backbone.Events, {

		// Initializes the computed's value and bindings:
		// this method is called independently from the object constructor,
		// allowing computeds to build and initialize in two passes by the parent model.
		init: function() {

			// Configure dependency map, then update the computed's value:
			// All Gonrin.Model attributes accessed while getting the initial value
			// will automatically register themselves within the model bindings map.
			var bindings = {};
			var deps = modelMap = [];
			this.get(true);
			modelMap = null;

			// If the computed has dependencies, then proceed to binding it:
			if (deps.length) {

				// Compile normalized bindings table:
				// Ultimately, we want a table of event types, each with an array of their associated targets:
				// {'change:name':[<model1>], 'change:status':[<model1>,<model2>]}

				// Compile normalized bindings map:
				_.each(deps, function(value) {
					var attribute = value[0];
					var target = value[1];

					// Populate event target arrays:
					if (!bindings[attribute]) {
						bindings[attribute] = [ target ];

					} else if (!_.contains(bindings[attribute], target)) {
						bindings[attribute].push(target);
					}
				});

				// Bind all event declarations to their respective targets:
				_.each(bindings, function(targets, binding) {
					for (var i=0, len=targets.length; i < len; i++) {
						this.listenTo(targets[i], binding, _.bind(this.get, this, true));
					}
				}, this);
			}
		},

		// Gets an attribute value from the parent model.
		val: function(attribute) {
			return this.model.get(attribute);
		},

		// Gets the computed's current value:
		// Computed values flagged as dirty will need to regenerate themselves.
		// Note: 'update' is strongly checked as TRUE to prevent unintended arguments (handler events, etc) from qualifying.
		get: function(update) {
			if (update === true && this._get) {
				var val = this._get.apply(this.model, _.map(this.deps, this.val, this));
				this.change(val);
			}
			return this.value;
		},

		// Sets the computed's current value:
		// computed values (have a custom getter method) require a custom setter.
		// Custom setters should return an object of key/values pairs;
		// key/value pairs returned to the parent model will be merged into its main .set() operation.
		set: function(val) {
			if (this._get) {
				if (this._set) return this._set.apply(this.model, arguments);
				else throw('Cannot set read-only computed attribute.');
			}
			this.change(val);
			return null;
		},

		// Changes the computed's value:
		// new values are cached, then fire an update event.
		change: function(value) {
			if (!_.isEqual(value, this.value)) {
				this.value = value;
				var evt = ['change:'+this.name, this.model, value];

				if (this.model._setting) {
					this.model._setting.push(evt);
				} else {
					evt[0] += ' change';
					this.model.trigger.apply(this.model, evt);
				}
			}
		},

		// Disposal:
		// cleans up events and releases references.
		dispose: function() {
			this.stopListening();
			this.off();
			this.model = this.value = null;
		}
	});


	// Gonrin.binding -> Binding API
	// ----------------------------

	var bindingSettings = {
			optionText: 'text',
			optionValue: 'value'
	};


	// Cache for storing binding parser functions:
	// Cuts down on redundancy when building repetitive binding views.
	var bindingCache = {};


	// Reads value from an accessor:
	// Accessors come in three potential forms:
	// => A function to call for the requested value.
	// => An object with a collection of attribute accessors.
	// => A primitive (string, number, boolean, etc).
	// This function unpacks an accessor and returns its underlying value(s).

	function readAccessor(accessor) {

		if (isFunction(accessor)) {
			// Accessor is function: return invoked value.
			return accessor();
		}
		else if (isObject(accessor)) {
			// Accessor is object/array: return copy with all attributes read.
			accessor = _.clone(accessor);

			_.each(accessor, function(value, key) {
				accessor[ key ] = readAccessor(value);
			});
		}
		// return formatted value, or pass through primitives:
		return accessor;
	}


	// Binding Handlers
	// ----------------
	// Handlers define set/get methods for exchanging data with the DOM.

	// Formatting function for defining new handler objects:
	function makeHandler(handler) {
		return isFunction(handler) ? {set: handler} : handler;
	}

	var bindingHandlers = {
			// Attribute: write-only. Sets element attributes.
			attr: makeHandler(function($element, value) {
				$element.attr(value);
			}),

			// Checked: read-write. Toggles the checked status of a form element.
			checked: makeHandler({
				get: function($element, currentValue, evt) {
					if ($element.length > 1) {
						$element = $element.filter(evt.target);
					}

					var checked = !!$element.prop('checked');
					var value = $element.val();

					if (this.isRadio($element)) {
						// Radio button: return value directly.
						return value;

					} else if (isArray(currentValue)) {
						// Checkbox array: add/remove value from list.
						currentValue = currentValue.slice();
						var index = _.indexOf(currentValue, value);

						if (checked && index < 0) {
							currentValue.push(value);
						} else if (!checked && index > -1) {
							currentValue.splice(index, 1);
						}
						return currentValue;
					}
					// Checkbox: return boolean toggle.
					return checked;
				},
				set: function($element, value) {
					if ($element.length > 1) {
						$element = $element.filter('[value="'+ value +'"]');
					}

					// Default as loosely-typed boolean:
					var checked = !!value;

					if (this.isRadio($element)) {
						// Radio button: match checked state to radio value.
						checked = (value == $element.val());

					} else if (isArray(value)) {
						// Checkbox array: match checked state to checkbox value in array contents.
						checked = _.contains(value, $element.val());
					}

					// Set checked property to element:
					$element.prop('checked', checked);
				},
				// Is radio button: avoids '.is(":radio");' check for basic Zepto compatibility.
				isRadio: function($element) {
					return $element.attr('type').toLowerCase() === 'radio';
				}
			}),

			// Class Name: write-only. Toggles a collection of class name definitions.
			classes: makeHandler(function($element, value) {
				_.each(value, function(enabled, className) {
					$element.toggleClass(className, !!enabled);
				});
			}),

			// Collection: write-only. Manages a list of views bound to a Backbone.Collection.
			collection: makeHandler({
				init: function($element, collection, context, bindings) {
					var self = this;
					this.i = bindings.itemView ? this.view[bindings.itemView] : this.view.itemView;
					if (!isCollection(collection)) throw('Binding "collection" requires a Collection.');
					//if (!isFunction(this.i)) throw('Binding "collection" requires an itemView.');
					this.v = {};
					
					//prepare uiControl
					
					this.view.uiControl.fields = this.view.uiControl.fields || [];
					this.view.uiControl.filterMode = this.view.uiControl.filterMode || "server";
					this.view.uiControl.filters = this.view.uiControl.filters || null;
					this.view.uiControl.orderByMode = this.view.uiControl.orderByMode || "server";
					this.view.uiControl.orderBy = this.view.uiControl.orderBy || null;
					this.view.uiControl.paginationMode = this.view.uiControl.paginationMode || "server";
					
					this.view.uiControl.primaryField = this.view.uiControl.primaryField || "id";
					
					this.view.uiControl.selectionMode = this.view.uiControl.selectionMode || "single";
					this.view.uiControl.onRowClick = this.view.uiControl.onRowClick || function(event, params){};
					
					this.view.uiControl.context = this.view;
					this.view.uiControl.dataSource = this.view.collection;
					this.view.uiControl.language = this.view.getApp().lang;
					this.view.uiControl.tableIdPrefix = this.view.cid;
					
					$element.grid(this.view.uiControl);
					//console.log(collection);
					this.view.uiControl.$el = $element;
				},
				set: function($element, collection, target) {
					//gonrin Grid here
					
					/*
					var view;
					var views = this.v;
					var ItemView = this.i;
					
					var models = collection.models;

					// Cache and reset the current dependency graph state:
					// sub-views may be created (each with their own dependency graph),
					// therefore we need to suspend the working graph map here before making children...
					var mapCache = viewMap;
					viewMap = null;

					// Default target to the bound collection object:
					// during init (or failure), the binding will reset.
					target = target || collection;

					if (isModel(target)) {

						// ADD/REMOVE Event (from a Model):
						// test if view exists within the binding...
						if (!views.hasOwnProperty(target.cid)) {

							// Add new view:
							views[ target.cid ] = view = new ItemView({model: target, collectionView: this.view});
							var index = _.indexOf(models, target);
							var $children = $element.children();

							// Attempt to add at proper index,
							// otherwise just append into the element.
							if (index < $children.length) {
								$children.eq(index).before(view.$el);
							} else {
								$element.append(view.$el);
							}

						} else {

							// Remove existing view:
							views[ target.cid ].remove();
							delete views[ target.cid ];
						}

					} else if (isCollection(target)) {

						// SORT/RESET Event (from a Collection):
						// First test if we're sorting...
						// (number of models has not changed and all their views are present)
						var sort = models.length === _.size(views) && collection.every(function(model) {
							return views.hasOwnProperty(model.cid);
						});

						// Hide element before manipulating:
						$element.children().detach();
						var frag = document.createDocumentFragment();

						if (sort) {
							// Sort existing views:
							collection.each(function(model) {
								frag.appendChild(views[model.cid].el);
							});

						} else {
							// Reset with new views:
							this.clean();
							collection.each(function(model) {
								views[ model.cid ] = view = new ItemView({model: model, collectionView: this.view});
								frag.appendChild(view.el);
							}, this);
						}

						$element.append(frag);
					}

					// Restore cached dependency graph configuration:
					viewMap = mapCache;*/
				},
				clean: function() {
					for (var id in this.v) {
						if (this.v.hasOwnProperty(id)) {
							this.v[ id ].remove();
							delete this.v[ id ];
						}
					}
				}
			}),

			// CSS: write-only. Sets a collection of CSS styles to an element.
			css: makeHandler(function($element, value) {
				$element.css(value);
			}),

			// Disabled: write-only. Sets the 'disabled' status of a form element (true :: disabled).
			disabled: makeHandler(function($element, value) {
				$element.prop('disabled', !!value);
			}),

			// Enabled: write-only. Sets the 'disabled' status of a form element (true :: !disabled).
			enabled: makeHandler(function($element, value) {
				$element.prop('disabled', !value);
			}),

			// HTML: write-only. Sets the inner HTML value of an element.
			html: makeHandler(function($element, value) {
				$element.html(value);
			}),

			// Options: write-only. Sets option items to a <select> element, then updates the value.
			options: makeHandler({
				init: function($element, value, context, bindings) {
					this.e = bindings.optionsEmpty;
					this.d = bindings.optionsDefault;
					this.v = bindings.value;
				},
				set: function($element, value) {

					// Pre-compile empty and default option values:
					// both values MUST be accessed, for two reasons:
					// 1) we need to need to guarentee that both values are reached for mapping purposes.
					// 2) we'll need their values anyway to determine their defined/undefined status.
					var self = this;
					var optionsEmpty = readAccessor(self.e);
					var optionsDefault = readAccessor(self.d);
					var currentValue = readAccessor(self.v);
					var options = isCollection(value) ? value.models : value;
					var numOptions = options.length;
					var enabled = true;
					var html = '';

					// No options or default, and has an empty options placeholder:
					// display placeholder and disable select menu.
					if (!numOptions && !optionsDefault && optionsEmpty) {

						html += self.opt(optionsEmpty, numOptions);
						enabled = false;

					} else {
						// Try to populate default option and options list:

						// Configure list with a default first option, if defined:
						if (optionsDefault) {
							options = [ optionsDefault ].concat(options);
						}

						// Create all option items:
						_.each(options, function(option, index) {
							html += self.opt(option, numOptions);
						});
					}

					// Set new HTML to the element and toggle disabled status:
					$element.html(html).prop('disabled', !enabled).val(currentValue);

					// Pull revised value with new options selection state:
					var revisedValue = $element.val();

					// Test if the current value was successfully applied:
					// if not, set the new selection state into the model.
					if (self.v && !_.isEqual(currentValue, revisedValue)) {
						self.v(revisedValue);
					}
				},
				opt: function(option, numOptions) {
					// Set both label and value as the raw option object by default:
					var label = option;
					var value = option;
					var textAttr = bindingSettings.optionText;
					var valueAttr = bindingSettings.optionValue;

					// Dig deeper into label/value settings for non-primitive values:
					if (isObject(option)) {
						// Extract a label and value from each object:
						// a model's 'get' method is used to access potential computed values.
						label = isModel(option) ? option.get(textAttr) : option[ textAttr ];
						value = isModel(option) ? option.get(valueAttr) : option[ valueAttr ];
					}

					return ['<option value="', value, '">', label, '</option>'].join('');
				},
				clean: function() {
					this.d = this.e = this.v = 0;
				}
			}),

			// Template: write-only. Renders the bound element with an Underscore template.
			template: makeHandler({
				init: function($element, value, context) {
					var raw = $element.find('script,template');
					this.t = _.template(raw.length ? raw.html() : $element.html());

					// If an array of template attributes was provided,
					// then replace array with a compiled hash of attribute accessors:
					if (isArray(value)) {
						return _.pick(context, value);
					}
				},
				set: function($element, value) {
					value = isModel(value) ? value.toJSON({computed:true}) : value;
					$element.html(this.t(value));
				},
				clean: function() {
					this.t = null;
				}
			}),

			// Text: read-write. Gets and sets the text value of an element.
			text: makeHandler({
				get: function($element) {
					return $element.text();
				},
				set: function($element, value) {
					$element.text(value);
				}
			}),

			// Toggle: write-only. Toggles the visibility of an element.
			toggle: makeHandler(function($element, value) {
				$element.toggle(!!value);
			}),

			// Value: read-write. Gets and sets the value of a form element.
			value: makeHandler({
				init: function($element, value, context, bindings) {
					
					var bind_attr = this.bind_attr = context['$bind_attribute'];
					var thisview = this.view;
					
					if(bind_attr && (typeof bind_attr === "string")){
						var fields = _.result(this.view.uiControl,'fields') || [],
							model_schema = _.result(this.view,'modelSchema') || {},
							field = null;
						
						_.each(fields, function(iterfield, index){
							if((!field) && (iterfield.field === bind_attr)){
								field = iterfield;
							}
						});
						if((field !== null) && (field.uicontrol !== false)){
							var uicontrol = null;
							field.value = value;
							
							switch(field.type) {
							    case "string":
							    	uicontrol = field.uicontrol || "textbox";
							        break;
							    case "number":
							    	uicontrol = field.uicontrol || "numeric";
							        break;
							    case "datetime":
							    	uicontrol = field.uicontrol || "datetimepicker";
							    	field.format = field.format || "YYYY-MM-DDTHH:mm:SS";
							    	field.textFormat = field.textFormat || "DD/MM/YYYY HH:mm:SS";
							    	field.extraFormats = field.extraFormats || ['DDMMYYYY'];
							    	
							    	break;
							    case "boolean":
							    	uicontrol = field.uicontrol || "textbox";
							    	break;
							    //type list 
							    	
							    default:
							        
							}
							if(uicontrol !== null){
								if ($.fn[uicontrol] === undefined) {
						        	console.log("$ is not support " + uicontrol);
								}else{
									field.context = thisview;
									$element[uicontrol](field);
									field.$el = $element;
								}
							}
					        
						};
						
					};
				},
				get: function($element) {
					if( (!!$element.data('gonrin'))&& !!($element.data('gonrin').getValue)){
						return $element.data('gonrin').getValue();
					}
					return $element.val();
				},
				set: function($element, value) {
					if( (!!$element.data('gonrin'))&& !!($element.data('gonrin').setValue)){
						$element.data('gonrin').setValue(value);
					}else{
						try {
							if ($element.val() + '' != value + '') $element.val(value);
						} catch (error) {
							// Error setting value: IGNORE.
							// This occurs in IE6 while attempting to set an undefined multi-select option.
							// unfortuantely, jQuery doesn't gracefully handle this error for us.
							// remove this try/catch block when IE6 is officially deprecated.
						}
					}
					
				},
				clean: function() {
					if( (!!this.$el.data('gonrin'))&& !!(this.$el.data('gonrin').destroy)){
						return this.$el.data('gonrin').destroy();
					}
					//destroy
				}
			}),
			dict: makeHandler({
				post_init: function($element, value, context, bindings) {
					var self = this;
					var bind_attr = this.bind_attr = context['$bind_attribute'];
					var thisview = this.view;
					if(bind_attr && (typeof bind_attr === "string")){
						var fields = _.result(this.view.uiControl,'fields') || [],
						model_schema = _.result(this.view,'modelSchema') || {},
						field = null;
					
						_.each(fields, function(iterfield, index){
							if((!field) && (iterfield.field === bind_attr)){
								field = iterfield;
							}
						});
						if(field !== null){
							var uicontrol = field.uicontrol || false;
							var itemView = field.itemView || false;
							var fieldname = field.field;
							//field.value = value;
							
							if(itemView !== false){
								var events = field.events || false;
								var viewData = null;
								var modelData = null;
								if(field.hasOwnProperty("viewData")){
									viewData =  isFunction(field["viewData"]) ? field["viewData"].call(thisview): field["viewData"];
								}
								if(field.hasOwnProperty("modelData")){
									modelData =  isFunction(field["modelData"]) ? field["modelData"].call(thisview): field["modelData"];
								}
								
								var fieldmodel = thisview.model.get(field.field);
								var view = thisview.createItemView(itemView, field.field, fieldmodel, $element, {viewData:viewData, modelData: modelData});
								if(events){
									$.each(events, function(key,func){
										view.on(key, $.proxy(func, thisview));
									})
								}
								thisview.on("removeBinding", function(attr){
									if((!attr)  || (attr === bind_attr)){
										view.removeBind();
									}
								});
								
							}else if(uicontrol !== false){
								switch(uicontrol) {
									case "ref":
								    	field.context = thisview;
								    	field.selectedItems = [];
								    	if(!!value){
								    		field.selectedItems.push(value);
								    	}
								        break;
								    default:
								}
								
								if ($.fn[uicontrol] === undefined) {
						        	console.log("$ is not support " + uicontrol);
								}else{
									$element[uicontrol](field);
									field.$el = $element;
									if((!!field.foreignRemoteField) && (!!field.foreignField)){
										$element.on('change.gonrin', function(evt){
						                	if((!!evt.value) && $.isPlainObject(evt.value)){
												thisview.model.set(field.foreignField, evt.value[field.foreignRemoteField]);
											}else{
												thisview.model.set(field.foreignField, null);
											}
						                });
									}
									
									
								}
							}
								
						}
					}
				},
				set: function($element, value) {
					if( (!!$element.data('gonrin'))&& !!($element.data('gonrin').setValue)){
						return $element.data('gonrin').setValue(value);
					}
					try {
						if ($element.val() + '' != value + '') $element.val(JSON.stringify(value));
					} catch (error) {}
						
				},
				get: function($element) {
					if( (!!$element.data('gonrin'))&& !!($element.data('gonrin').getValue)){
						return $element.data('gonrin').getValue();
					}
					try {
						return $.parseJSON( $element.val() );
					} catch (error) {
						// Error setting value: IGNORE.
						// This occurs in IE6 while attempting to set an undefined multi-select option.
						// unfortuantely, jQuery doesn't gracefully handle this error for us.
						// remove this try/catch block when IE6 is officially deprecated.
					}
					return null;
				},
				clean: function() {
					this.view.trigger("removeBinding", this.bind_attr);
					if( (!!this.$el.data('gonrin'))&& !!(this.$el.data('gonrin').destroy)){
						return this.$el.data('gonrin').destroy();
					}
				}
			}),
			list: makeHandler({
				post_init: function($element, value, context, bindings) {
					var self = this;
					var bind_attr = this.bind_attr = context['$bind_attribute'];
					var thisview = this.view;
					
					if(bind_attr && (typeof bind_attr === "string")){
						var fields = _.result(this.view.uiControl,'fields') || [],
							model_schema = _.result(this.view,'modelSchema') || {},
							field = null;
						
						_.each(fields, function(iterfield, index){
							if((!field) && (iterfield.field === bind_attr)){
								field = iterfield;
							}
						});
						
						if(field !== null){
							var uicontrol = field.uicontrol || false;
							var itemView = field.itemView || false;
							var fieldname = field.field;
							
							if(itemView !== false){
								var events = field.events || false;
								var viewData = null;
								var modelData = null;
								if(field.hasOwnProperty("viewData")){
									viewData =  isFunction(field["viewData"]) ? field["viewData"].call(thisview): field["viewData"];
								}
								if(field.hasOwnProperty("modelData")){
									modelData =  isFunction(field["modelData"]) ? field["modelData"].call(thisview): field["modelData"];
								}
								
								//render tools
								var tools = field.tools || [];
								var toolEl = field.toolEl;
								var $toolEl = thisview.$el.find(toolEl);
								
								if((!!$toolEl) && ($.isArray(tools))){
									$toolEl.empty();
									$.each(tools, function(iter, button){
										//var button = null;
										var label = thisview.getApp().translate(button.label) || button.name;
										if((button.type === "button") && thisview._toolIsVisible(button)){
											var $tool = $("<button/>").attr({"type":"button", "btn-name":button.name}).addClass("btn btn-listitem").html(label);
											$tool.addClass(button.buttonClass || "btn-default btn-xs");
											$toolEl.append($tool);
											if (button.command === "create"){
												$tool.unbind("click").bind("click", function(){
													var fieldmodel = thisview.model.get(field.field);
													var view = thisview.createItemView(itemView, field.field, null, $element, {viewData:viewData, modelData: modelData});
													if(events){
														$.each(events, function(key,func){
															view.on(key, $.proxy(func, thisview));
														})
													}
													thisview.on("removeBinding", function(attr){
														if((!attr)  || (attr === bind_attr)){
															view.removeBind();
														}
													});
													fieldmodel.push(view.model.toJSON());
													thisview.model.trigger("change:"+ field.field);
												});
											}
										}
									});
								}
								//end render tools
								
								var fieldmodel = thisview.model.get(field.field);
								if($.isArray(fieldmodel)){
									for(var idx = 0; idx < fieldmodel.length; idx++){
										var view = thisview.createItemView(itemView, field.field, fieldmodel[idx], $element, {viewData:viewData, modelData: modelData});
										if(events){
											$.each(events, function(key,func){
												view.on(key, $.proxy(func, thisview));
											})
										}
										//thisview.on("removeBinding", function(attr){
										//	view.removeBind();
										//});
										thisview.on("removeBinding", function(attr){
											if((!attr)  || (attr === bind_attr)){
												view.removeBind();
											}
										});
									}
								}
								
							}else if(uicontrol !== false){
								switch(uicontrol) {
									case "ref":
								    	field.context = this.view;
								    	field.selectedItems = field.selectedItems || [];
								    	if((!!value) && $.isArray(value) && (value.length >0)){
								    		field.selectedItems = value;
								    	}
								        break;
								    case "grid":
								    	field.dataSource = this.view.model.get(bind_attr) ||[];
								    	field.context = this.view;
								        break;
								    default:
								}
								
								if ($.fn[uicontrol] === undefined) {
						        	console.log("$ is not support " + uicontrol);
								}else{
									$element[uicontrol](field);
									field.$el = $element;
								}
							}
					        
						};
					
					}
					
					
				},
				set: function($element, value) {
					if( (!!$element.data('gonrin'))&& !!($element.data('gonrin').setValue)){
						return $element.data('gonrin').setValue(value);
					}
					try {
						if ($element.val() + '' != value + '') $element.val(JSON.stringify(value));
					} catch (error) {}
				},
				get: function($element) {
					if( (!!$element.data('gonrin'))&& !!($element.data('gonrin').getValue)){
						return $element.data('gonrin').getValue();
					}
					try {
						return $.parseJSON( $element.val() );
					} catch (error) {}
					return null;
				},
				clean: function() {
					//Fix remove binding but save model
					this.view.trigger("removeBinding", this.bind_attr);
					if( (!!this.$el.data('gonrin'))&& !!(this.$el.data('gonrin').destroy)){
						return this.$el.data('gonrin').destroy();
					}
				}
			})
	};


	// Binding Filters
	// ---------------
	// Filters are special binding handlers that may be invoked while binding;
	// they will return a wrapper function used to modify how accessors are read.

	// Partial application wrapper for creating binding filters:
	function makeFilter(handler) {
		return function() {
			var params = arguments;
			var read = isFunction(handler) ? handler : handler.get;
			var write = handler.set;
			return function(value) {
				return isUndefined(value) ?
						read.apply(this, _.map(params, readAccessor)) :
							params[0]((write ? write : read).call(this, value));
			};
		};
	}

	var bindingFilters = {
			// Positive collection assessment [read-only]:
			// Tests if all of the provided accessors are truthy (and).
			all: makeFilter(function() {
				var params = arguments;
				for (var i=0, len=params.length; i < len; i++) {
					if (!params[i]) return false;
				}
				return true;
			}),

			// Partial collection assessment [read-only]:
			// tests if any of the provided accessors are truthy (or).
			any: makeFilter(function() {
				var params = arguments;
				for (var i=0, len=params.length; i < len; i++) {
					if (params[i]) return true;
				}
				return false;
			}),

			// Collection length accessor [read-only]:
			// assumes accessor value to be an Array or Collection; defaults to 0.
			length: makeFilter(function(value) {
				return value.length || 0;
			}),

			// Negative collection assessment [read-only]:
			// tests if none of the provided accessors are truthy (and not).
			none: makeFilter(function() {
				var params = arguments;
				for (var i=0, len=params.length; i < len; i++) {
					if (params[i]) return false;
				}
				return true;
			}),

			// Negation [read-only]:
			not: makeFilter(function(value) {
				return !value;
			}),

			// Formats one or more accessors into a text string:
			// ('$1 $2 did $3', firstName, lastName, action)
			format: makeFilter(function(str) {
				var params = arguments;

				for (var i=1, len=params.length; i < len; i++) {
					// TODO: need to make something like this work: (?<!\\)\$1
					str = str.replace(new RegExp('\\$'+i, 'g'), params[i]);
				}
				return str;
			}),

			// Provides one of two values based on a ternary condition:
			// uses first param (a) as condition, and returns either b (truthy) or c (falsey).
			select: makeFilter(function(condition, truthy, falsey) {
				return condition ? truthy : falsey;
			}),

			// CSV array formatting [read-write]:
			csv: makeFilter({
				get: function(value) {
					value = String(value);
					return value ? value.split(',') : [];
				},
				set: function(value) {
					return isArray(value) ? value.join(',') : value;
				}
			}),

			// Integer formatting [read-write]:
			integer: makeFilter(function(value) {
				return value ? parseInt(value, 10) : 0;
			}),

			// Float formatting [read-write]:
			decimal: makeFilter(function(value) {
				return value ? parseFloat(value) : 0;
			})
	};

	// Define allowed binding parameters:
	// These params may be included in binding handlers without throwing errors.
	var allowedParams = {
			events: 1,
			itemView: 1,
			optionsDefault: 1,
			optionsEmpty: 1
	};

	// Define binding API:
	Gonrin.binding = {
			allowedParams: allowedParams,
			addHandler: function(name, handler) {
				bindingHandlers[ name ] = makeHandler(handler);
			},
			addFilter: function(name, handler) {
				bindingFilters[ name ] = makeFilter(handler);
			},
			config: function(settings) {
				_.extend(bindingSettings, settings);
			},
			emptyCache: function() {
				bindingCache = {};
			}
	};

	Gonrin.getDefaultModel = function(schema){
		var defaults = {};
    	_.each(schema, function(props, key) {
    		if(isObject(props)){
				defaults[key] = props.hasOwnProperty('default') ? _.result(props, 'default') : null;
				if ((defaults[key] === null) && (_.result(props, 'type') === "list")){
					defaults[key] = [];
				}
			}
    	});
    	return defaults;
	}
	// Gonrin.View
	// ----------
	var viewMap;
	var viewProps = ['schema', 'modelClass', 'viewModel', 'viewData', 'uiControl', 'sessionKey', 'bindings', 'bindingFilters', 'bindingHandlers', 'bindingSources', 'computeds'];
	
	Gonrin.View = Backbone.View.extend({
		_super: Backbone.View,
		// Backbone.View constructor override:
		// sets up binding controls around call to super.
		constructor: function(options) {
			_.extend(this, _.pick(options||{}, viewProps));
			_super(this, 'constructor', arguments);
			
    		this.initModel((options || {}).modelData);
    		this.initFields();
    		
    		this.$el.empty();
			if(this.template){
				if(!!gonrin && !!gonrin.template){
					var tpl = gonrin.template(this.template)({});
					this.$el.html(tpl);
				}else{
					this.$el.html(this.template);
				}
			}
    		this.initToolbar(this.tools);
    		this.bindEvents();
		},
		// Bindings list accessor:
		b: function() {
			return this._b || (this._b = []);
		},
    	modelSchema: null,
    	viewData: null,
		// Bindings definition:
		// this setting defines a DOM attribute name used to query for bindings.
		// Alternatively, this be replaced with a hash table of key/value pairs,
		// where 'key' is a DOM query and 'value' is its binding declaration.
		bindings: 'data-bind',
		
		bindingBlocks: 'block-bind',
		

		// Setter options:
		// Defines an optional hashtable of options to be passed to setter operations.
		// Accepts a custom option '{save:true}' that will write to the model via ".save()".
		setterOptions: null,
		
		destroy: function() {

		    // COMPLETELY UNBIND THE VIEW
		    this.undelegateEvents();
		    this.$el.removeData().unbind();
		    // Remove view from DOM
		    this.remove();  
		    Backbone.View.prototype.remove.call(this);
		},
		getApp: function(){
			return gonrinApp();
		},
		getServiceURL: function(){
			return gonrinApp().serviceURL;
		},
		isInDOM: function(){
			return this.$el.closest('body').size() > 0;
		},
		initModel: function(modelData){ return this },
		bindEvents: function(){ return this },
		getDefaultModel: function(){
			if(this.modelSchema){
				return Gonrin.getDefaultModel(this.modelSchema);
			}
			return null;
		},
		initFields: function(){
			return this;
		},
    	
    	_toolIsVisible : function(tool){
			var self = this;
			var visible = "visible";
            return !tool.hasOwnProperty(visible) || (tool.hasOwnProperty(visible) && (isFunction(tool[visible]) ? tool[visible].call(self) : (tool[visible] === true)) );
		},
    	initToolbar: function(tools){
    		
			var self = this;
			if(!this.toolbar){
				this.toolbar = $('<div/>').addClass("toolbar");
				this.$el.find("[" + self.bindingBlocks + "=toolbar]").append(self.toolbar);
			}else{
				this.toolbar.empty();
			}
			
			tools = tools || [];
			
			_.each(tools, function(tool, index) {
				if((tool.type === "group") && self._toolIsVisible(tool)){
					var $group = $("<div/>").addClass("btn-group").appendTo(self.toolbar);
					if(tool.groupClass){
						$group.addClass(tool.groupClass);
					}
					if(tool.buttons){
						_.each(tool.buttons, function(button, _i) {
							var label = self.getApp().translate(button.label) || button.name;
							if((button.type === "button") && self._toolIsVisible(button)){
								var $tool = $("<button/>").attr({"type":"button", "btn-name":button.name}).addClass("btn").html(label);
								$tool.addClass(button.buttonClass || "btn-default");
								$group.append($tool);
								if(button.command){
									$tool.bind("click", $.proxy(button.command, self));
								}
							}
						});
					}
				}
				if((tool.type === "button")&& self._toolIsVisible(tool)){
					var label = self.getApp().translate(tool.label) || tool.name;
					var $tool = $("<button/>").attr({"type":"button", "btn-name":tool.name}).addClass("btn").html(label);
					$tool.addClass(tool.buttonClass || "btn-default");
					self.toolbar.append($tool);
					if(tool.command){
						$tool.bind("click", $.proxy(tool.command, self));
					}
				}
			});
			return this;
		},
		extendToolbar: function(tools){
			if(!!tools){
				this.initToolbar(tools);
			}
		},
		renderToolbar: function(tools){
			this.initToolbar(tools);
		},
		loader: function(opts){
			var self = this;
			var waitTpl = "<div style='position: absolute;top: 50%;left:48%'><span class='glyphicon glyphicon-hourglass' style='font-size: 200%;'></span></div>";
			var reloadTpl = "<a style='position: absolute;top: 50%;left:48%' href='javascript:void(0);' onclick='javascript:gonrinApp().getRouter().refresh()'><span class='glyphicon glyphicon-refresh' style='font-size: 200%;'></span></a>";
		    
			if((typeof options != 'undefined') || $.isPlainObject(opts)){
				var loader = self.$el.find("#" + self.cid + "_loader");
				if(loader.length == 0){
	    			loader = $("<div>").attr("id", self.cid + "_loader").addClass('view-loader').css({
	        			width: "100%",
	        			height: "100%",
	        			position: "absolute",
	        			background: "#ffffff",
	        			"z-index": 99999999,
	        			left: "0px",
	        			top: "0px"
	        		});
	    		}
				var message = "";
				var parent = self.$el;
				
				if($.isPlainObject(opts)){
					if(opts.message === "LOADER_WAIT"){
						message = waitTpl;
					}
					else if(opts.message === "LOADER_RELOAD"){
						message = reloadTpl;
					}
					else{
						message = opts.message || waitTpl;
					}
					
					if(opts.el){
						parent = self.$el.find(opts.el);
					}
				}
				loader.html(message);
				if(!!parent){
					parent.append(loader);
				}
				
			}
			if(opts === false){
	    		self.$el.find("#" + self.cid + "_loader").remove();
			}
		},
		
		render: function(){ return this },
		// Compiles a model context, then applies bindings to the view:
		// All Model->View relationships will be baked at the time of applying bindings;
		// changes in configuration to source attributes or view bindings will require a complete re-bind.
		applyBindings: function() {
			
			this.removeBindings();
			var self = this;
			var sources = _.clone(_.result(self, 'bindingSources'));
			var declarations = self.bindings; //data-bind

			var options = self.setterOptions;
			
			var handlers = _.clone(bindingHandlers);
			var filters = _.clone(bindingFilters);
			
			var context = self._c = {};
			
			// Compile a complete set of binding handlers for the view:
			// mixes all custom handlers into a copy of default handlers.
			// Custom handlers defined as plain functions are registered as read-only setters.
			_.each(_.result(self, 'bindingHandlers')||{}, function(handler, name) {
				handlers[ name ] = makeHandler(handler);
			});

			// Compile a complete set of binding filters for the view:
			// mixes all custom filters into a copy of default filters.
			_.each(_.result(self, 'bindingFilters')||{}, function(filter, name) {
				filters[ name ] = makeFilter(filter);
			});

			// Add native 'model' and 'collection' data sources:
			self.model = addSourceToViewContext(self, context, options, 'model');
			self.viewModel = addSourceToViewContext(self, context, options, 'viewModel');
			self.collection = addSourceToViewContext(self, context, options, 'collection');

			// Support legacy "collection.view" API for rendering list items:
			// **Deprecated: will be removed after next release*.*
			if (self.collection && self.collection.view) {
				self.itemView = self.collection.view;
			}

			// Add all additional data sources:
			if (sources) {
				_.each(sources, function(source, sourceName) {
					sources[ sourceName ] = addSourceToViewContext(sources, context, options, sourceName, sourceName);
				});

				// Reapply resulting sources to view instance.
				self.bindingSources = sources;
			}

			// Add all computed view properties:
			_.each(_.result(self, 'computeds')||{}, function(computed, name) {
				var getter = isFunction(computed) ? computed : computed.get;
				var setter = computed.set;
				var deps = computed.deps;

				context[ name ] = function(value) {
					return (!isUndefined(value) && setter) ?
							setter.call(self, value) :
								getter.apply(self, getDepsFromViewContext(self._c, deps));
				};
			});
			// Create all bindings:
			// bindings are created from an object hash of query/binding declarations,
			// OR based on queried DOM attributes.
			if (isObject(declarations)) {

				// Object declaration method:
				// {'span.my-element': 'text:attribute'}

				_.each(declarations, function(elementDecs, selector) {
					// Get DOM jQuery reference:
					var $element = queryViewForSelector(self, selector);

					// flattern object notated binding declaration
					if (isObject(elementDecs)) {
						elementDecs = flattenBindingDeclaration(elementDecs);
					}

					// Ignore empty DOM queries (without errors):
					if ($element.length) {
						bindElementToView(self, $element, elementDecs, context, handlers, filters);
					}
				});

			} else {
				// DOM attributes declaration method:
				// <span data-bind='text:attribute'></span>

				// Create bindings for each matched element:
				queryViewForSelector(self, '['+declarations+']').each(function() {
					var $element = Backbone.$(this);
					bindElementToView(self, $element, $element.attr(declarations), context, handlers, filters);
				});
			}
		},

		// Gets a value from the binding context:
		getBinding: function(attribute) {
			return accessViewContext(this._c, attribute);
		},

		// Sets a value to the binding context:
		setBinding: function(attribute, value) {
			return accessViewContext(this._c, attribute, value);
		},

		// Disposes of all view bindings:
		removeBindings: function() {
			this._c = null;

			if (this._b) {
				while (this._b.length) {
					this._b.pop().dispose();
				}
			}
		},
		// Backbone.View.remove() override:
		// unbinds the view before performing native removal tasks.
		remove: function() {
			this.removeBindings();
			_super(this, 'remove', arguments);
		}

	}, mixins);

	// Gonrin.View -> Private
	// ---------------------

	// Adds a data source to a view:
	// Data sources are Backbone.Model and Backbone.Collection instances.
	// @param source: a source instance, or a function that returns a source.
	// @param context: the working binding context. All bindings in a view share a context.
	function addSourceToViewContext(source, context, options, name, prefix) {

		// Resolve source instance:
		source = _.result(source, name);

		// Ignore missing sources, and invoke non-instances:
		if (!source) return;

		// Add Backbone.Model source instance:
		if (isModel(source)) {
			// Establish source prefix:
			prefix = prefix ? prefix+'_' : '';

			// Create a read-only accessor for the model instance:
			context['$'+name] = function() {
				viewMap && viewMap.push([source, 'change']);
				return source;
			};

			// Compile all model attributes as accessors within the context:
			_.each(source.toJSON({computed:true}), function(value, attribute) {
				// Create named accessor functions:
				// -> Attributes from 'view.model' use their normal names.
				// -> Attributes from additional sources are named as 'source_attribute'.
				context[prefix+attribute] = function(value) {
					context["$bind_attribute"] = attribute;
					return accessViewDataAttribute(source, attribute, value, options);
				};
			});
		}
		// Add Backbone.Collection source instance:
		else if (isCollection(source)) {
			// Create a read-only accessor for the collection instance:
			context['$'+name] = function() {
				viewMap && viewMap.push([source, 'reset add remove sort update']);
				return source;
			};
		}

		// Return original object, or newly constructed data source:
		return source;
	}

	// Attribute data accessor:
	// exchanges individual attribute values with model sources.
	// This function is separated out from the accessor creation process for performance.
	// @param source: the model data source to interact with.
	// @param attribute: the model attribute to read/write.
	// @param value: the value to set, or 'undefined' to get the current value.
	function accessViewDataAttribute(source, attribute, value, options) {
		// Register the attribute to the bindings map, if enabled:
		viewMap && viewMap.push([source, 'change:'+attribute]);

		// Set attribute value when accessor is invoked with an argument:
		if (!isUndefined(value)) {

			// Set Object (non-null, non-array) hashtable value:
			//if (!isObject(value) || isArray(value) || _.isDate(value)) {
				var val = value;
				value = {};
				value[attribute] = val;
			//}
			
			// Set value:
			return options && options.save ? source.save(value, options) : source.set(value, options);
		}
		
		// Get the attribute value by default:
		return source.get(attribute);
	}

	// Queries element selectors within a view:
	// matches elements within the view, and the view's container element.
	function queryViewForSelector(view, selector) {

		if (selector === ':el' || selector === ':scope') return view.$el;
		var $elements = view.$(selector);
		// Include top-level view in bindings search:
		if (view.$el.is(selector)) {
			$elements = $elements.add(view.$el);
		}

		return $elements;
	}

	// Binds an element into a view:
	// The element's declarations are parsed, then a binding is created for each declared handler.
	// @param view: the parent View to bind into.
	// @param $element: the target element (as jQuery) to bind.
	// @param declarations: the string of binding declarations provided for the element.
	// @param context: a compiled binding context with all availabe view data.
	// @param handlers: a compiled handlers table with all native/custom handlers.
	function bindElementToView(view, $element, declarations, context, handlers, filters) {
		// Parse localized binding context:
		// parsing function is invoked with 'filters' and 'context' properties made available,
		// yeilds a native context object with element-specific bindings defined.
		try {
			var parserFunct = bindingCache[declarations] || (bindingCache[declarations] = new Function('$f','$c','with($f){with($c){return{'+ declarations +'}}}'));
			var bindings = parserFunct(filters, context);
		} catch (error) {
			throw('Error parsing bindings: "'+declarations +'"\n>> '+error);
		}

		// Format the 'events' option:
		// include events from the binding declaration along with a default 'change' trigger,
		// then format all event names with a '.Gonrin' namespace.
		var events = _.map(_.union(bindings.events || [], ['change']), function(name) {
			return name+'.gonrin';
		}).join(' ');
		// Apply bindings from native context:
		_.each(bindings, function(accessor, handlerName) {
		
			// Validate that each defined handler method exists before binding:
			if (handlers.hasOwnProperty(handlerName)) {
				// Create and add binding to the view's list of handlers:
				view.b().push(new GonrinBinding(view, $element, handlers[handlerName], accessor, events, context, bindings));
			} else if (!allowedParams.hasOwnProperty(handlerName)) {
				throw('binding handler "'+ handlerName +'" is not defined.');
			}
		});
	}

	// Gets and sets view context data attributes:
	// used by the implementations of "getBinding" and "setBinding".
	function accessViewContext(context, attribute, value) {
		if (context && context.hasOwnProperty(attribute)) {
			return isUndefined(value) ? readAccessor(context[attribute]) : context[attribute](value);
		}
	}

	// Accesses an array of dependency properties from a view context:
	// used for mapping view dependencies by manual declaration.
	function getDepsFromViewContext(context, attributes) {
		var values = [];
		if (attributes && context) {
			for (var i=0, len=attributes.length; i < len; i++) {
				values.push(attributes[i] in context ? context[ attributes[i] ]() : null);
			}
		}
		return values;
	}

	// Converts a binding declaration object into a flattened string.
	// Input: {text: 'firstName', attr: {title: '"hello"'}}
	// Output: 'text:firstName,attr:{title:"hello"}'
	function flattenBindingDeclaration(declaration) {
		var result = [];

		for (var key in declaration) {
			var value = declaration[key];

			if (isObject(value)) {
				value = '{'+ flattenBindingDeclaration(value) +'}';
			}

			result.push(key +':'+ value);
		}

		return result.join(',');
	}


	// Gonrin.View -> Binding
	// ---------------------
	// The binding object connects an element to a bound handler.
	// @param view: the view object this binding is attached to.
	// @param $element: the target element (as jQuery) to bind.
	// @param handler: the handler object to apply (include all handler methods).
	// @param accessor: an accessor method from the binding context that exchanges data with the model.
	// @param events:
	// @param context:
	// @param bindings:
	function GonrinBinding(view, $element, handler, accessor, events, context, bindings) {

		var self = this;
		var tag = ($element[0].tagName).toLowerCase();
		var changable = (tag == 'input' || tag == 'select' || tag == 'textarea' || $element.prop('contenteditable') == 'true');
		var triggers = [];
		var reset = function(target) {
			self.$el && self.set(self.$el, readAccessor(accessor), target);
		};

		self.view = view;
		self.$el = $element;
		self.evt = events;
		_.extend(self, handler);

		// Initialize the binding:
		// allow the initializer to redefine/modify the attribute accessor if needed.
		accessor = self.init(self.$el, readAccessor(accessor), context, bindings) || accessor;

		// Set default binding, then initialize & map bindings:
		// each binding handler is invoked to populate its initial value.
		// While running a handler, all accessed attributes will be added to the handler's dependency map.
		viewMap = triggers;
		reset();
		viewMap = null;

		// Configure READ/GET-able binding. Requires:
		// => Form element.
		// => Binding handler has a getter method.
		// => Value accessor is a function.
		if (changable && handler.get && isFunction(accessor)) {
			self.$el.on(events, function(evt) {
				accessor(self.get(self.$el, readAccessor(accessor), evt));
			});
		}

		// Configure WRITE/SET-able binding. Requires:
		// => One or more events triggers.
		if (triggers.length) {
			for (var i=0, len=triggers.length; i < len; i++) {
				self.listenTo(triggers[i][0], triggers[i][1], reset);
			}
		}
		//
		self.post_init(self.$el, readAccessor(accessor), context, bindings);
	}

	_.extend(GonrinBinding.prototype, Backbone.Events, {

		// Pass-through binding methods:
		// for override by actual implementations.
		init: blankMethod,
		post_init: blankMethod,
		get: blankMethod,
		set: blankMethod,
		clean: blankMethod,

		// Destroys the binding:
		// all events and managed sub-views are killed.
		dispose: function() {
			this.clean();
			this.stopListening();
			this.$el.off(this.evt);
			this.$el = this.view = null;
		}
	});

	var collectionMap;
	var collectionProps = ['page, numRows', 'filters'];

	Gonrin.Collection = Backbone.Collection.extend({
		_super: Backbone.Collection,
		page:null,
		totalPages: null,
		numRows:null,
		filters: null,
		constructor: function(attributes, options) {
			_.extend(this, _.pick(options||{}, collectionProps));
			_super(this, 'constructor', arguments);
		},
		parse: function (response) {
    		this.page = response.page;
    		this.numRows = response.num_results;
    		this.totalPages = response.total_pages;
			return response.objects;
		},
	});
	
	Gonrin.CollectionView = Gonrin.View.extend({
		initModel: function(modelData){
        	this.collection = new Gonrin.Collection(Gonrin.Model);
        	var serviceURL = this.getApp().serviceURL !== null? this.getApp().serviceURL :"" ;
        	this.collection.url = serviceURL + this.urlPrefix + this.collectionName;
	    },
	    tools: [
      	    {
      	    	name: "default",
      	    	type: "group",
      	    	groupClass: "toolbar-group",
      	    	buttons: [
  					{
  		    	    	name: "create",
  		    	    	type: "button",
  		    	    	buttonClass: "btn-success btn-sm",
  		    	    	label: "TRANSLATE:CREATE",
  		    	    	command: function(){
  		    	    		var self = this;
  		    	    		var path = self.collectionName + '/model';
  		    	    		self.getApp().getRouter().navigate(path);
  		    	    	}
  		    	    },
  					
      	    	]
      	    },
      	],
      	initFields: function(){
    		var self = this;
        	var schema = _.result(this, "modelSchema") || {};
        	
        	this.uiControl = this.uiControl || {};
        	this.uiControl.$el = this.uiControl.$el || null;
        	this.uiControl.fields = this.uiControl.fields || [];
        	
        	var fields_from_schema = [];
        	_.each(schema, function(obj, key) {
        		var field = {field: key};
        		var viewfieldlst = $.grep(self.uiControl.fields, function(f){ return f.field === key; });
        		if( !(viewfieldlst && (viewfieldlst.length == 1))){
        			field["visible"] = false;
        			self.uiControl.fields.push(field);
        		}
        		if (!!obj.primary){
        			if (!self.uiControl.primaryField){
        				self.uiControl.primaryField = key;
            		}
        		}
        		
        		//fields_from_schema.push(field);
        	});
        	
        	var key = this.uiControl.fields.length;
        	while (key--) {
        		var field = this.uiControl.fields[key];
        	    if((!isObject(field))|| (field.field === null) || ((field.field === undefined))){
					self.fields.splice(key, 1);
					continue;
				}
				var schema_field = schema[field.field];
				
				if(schema_field){
					if(!field.required){
						field.required = schema_field.required ? schema_field.required: false;
					};
					if(!field.label){
						field.label = schema_field.label ? schema_field.label: field.field;
					};
					field.type = schema_field.type;
					field.$el = field.$el || null;
					field.bootstrap_version = self.getApp().bootstrap_version || 4;
				}else{
					if((field.field !== "command") && ((!!field.command)|| (!!field.menu))){
						self.uiControl.fields.splice(key, 1);
					}
				}
        	}
        	
    		return this;
	    },
	    getCollectionElement: function(){
	    	return this.uiControl.$el;
	    },
	    setSelectedItems:function(items){
	    	this.uiControl.selectedItems = items;
	    },
	    getPageFromSession: function(){
    		var self = this;
    		var page = null;
    		if((self.sessionKey !== null) && (self.sessionKey.length > 0)){
    			page = self.getApp().data(self.sessionKey + '_page') || null;
    		}
    		return page;
    	},
    	savePageToSession: function(page){
    		var self = this;
    		if((self.sessionKey !== null) && (self.sessionKey.length > 0)){
    			self.getApp().data(self.sessionKey + '_page', page);
    		}
    		return this;
    	},
	});
	
	
	Gonrin.ModelView = Gonrin.View.extend({
		modelIdAttribute: null,
		removeBinding: function(fieldname) {
			var self = this;
			if(this._b){
				for(var i = 0; i < this._b.length; i++){
					if ((!!this._b[i].bind_attr) && (this._b[i].bind_attr === fieldname)){
						this._b[i].dispose();
						this._b.splice(i,1);
						return;
					}
				}
			}
		},
		applyBinding: function(fieldname) {
			var self = this;
			var sources = _.clone(_.result(self, 'bindingSources'));
			var context = self._c;
			
			if(!context){
				throw 'This view must run applyBindings first';
			}
			
			self.removeBinding(fieldname);
			
			var declarations = self.bindings; //data-bind

			var options = self.setterOptions;
			
			var handlers = _.clone(bindingHandlers);
			var filters = _.clone(bindingFilters);
			
			// Compile a complete set of binding handlers for the view:
			// mixes all custom handlers into a copy of default handlers.
			// Custom handlers defined as plain functions are registered as read-only setters.
			_.each(_.result(self, 'bindingHandlers')||{}, function(handler, name) {
				handlers[ name ] = makeHandler(handler);
			});

			// Compile a complete set of binding filters for the view:
			// mixes all custom filters into a copy of default filters.
			_.each(_.result(self, 'bindingFilters')||{}, function(filter, name) {
				filters[ name ] = makeFilter(filter);
			});

			queryViewForSelector(self, '['+declarations+'*="' + fieldname + '"]').each(function() {
				var $element = Backbone.$(this);
				bindElementToView(self, $element, $element.attr(declarations), context, handlers, filters);
			});
		},
		initModel: function(modelData){
			var self = this;
			
			if(!!this.model){
				return this;
			}
			var def = this.getDefaultModel() || {};
			if(this.modelClass){
				this.model = new this.modelClass(def,{modelData: modelData});
			}
			else if(this.modelSchema){
				this.model = new Gonrin.Model(def,{modelData: modelData});
			}
			if(this.model.urlRoot == null){
				var serviceURL = this.getApp().serviceURL !== null? this.getApp().serviceURL :"" ;
				this.model.urlRoot = serviceURL + this.urlPrefix + this.collectionName;
			}
			return this;
		},
		initFields: function(){
    		var self = this;
        	var schema = _.result(this, "modelSchema") || {};
        	
        	this.uiControl = this.uiControl || {};
        	this.uiControl.$el = this.uiControl.$el || null;
        	this.uiControl.fields = this.uiControl.fields || [];
        	
        	var fields_from_schema = [];
        	_.each(schema, function(obj, key) {
        		var field = {field: key};
        		var viewfieldlst = $.grep(self.uiControl.fields, function(f){ return f.field === key; });
        		if( !(viewfieldlst && (viewfieldlst.length == 1))){
        			self.uiControl.fields.push(field);
        		}
        		if (!!obj.primary){
        			if ((!self.model.idAttribute || self.model.idAttribute == "id") && (key !== "id")){
        				self.model.idAttribute = key;
            		}
        		}
        	});
        	
        	var key = this.uiControl.fields.length;
        	while (key--) {
        		var field = this.uiControl.fields[key];
        	    if((!isObject(field))|| (field.field === null) || ((field.field === undefined))){
					self.uiControl.fields.splice(key, 1);
					continue;
				}
				var schema_field = schema[field.field];
				
				if(schema_field){
					if(!field.required){
						field.required = schema_field.required ? schema_field.required: false;
					};
					if(!field.label){
						field.label = schema_field.label ? schema_field.label: field.field;
					};
					field.type = schema_field.type;
					field.$el = field.$el || null;
					field.bootstrap_version = self.getApp().bootstrap_version || 4;
				}else{
					if((field.field !== "command") && ((!!field.command)|| (!!field.menu))){
						self.uiControl.splice(key, 1);
					}
				}
        	}
        	
        	//edit me
        	
    		return this;
    	},
    	getFieldElement: function(name){
    		var self = this;
    		for (var i = 0; i < self.uiControl.fields.length; i++){
    			var field = self.uiControl.fields[i];
    			if (field.field === name){
    				return field.$el || null;
    			}
    		};
    		return null;
    	},
    	createItemView: function(itemView, fieldname, value, $element, options){
			var self = this;
			options = options || null;
    		var view = new itemView({
    			//parentView: self, 
    			viewData: (options !== null ? options.viewData : null),
    			modelData: (options !== null ? options.modelData : null),
    		});
    		
    		
    		if(value !== null){
    			view.model.set(value);
    		}
    		
			if((!!view.foreignRemoteField) && (!!view.foreignField)){
				var refval = self.model.get(view.foreignRemoteField) || null;
				if((refval !== null) && (value === null)){
					view.model.set(view.foreignField, refval);
				}
			}
			
    		view.on('itemDeleted', function(evtobj){
    			var idAttribute = view.model.idAttribute;
    			var fieldmodel = self.model.get(fieldname);
    			
    			
    			if(!!idAttribute){
					if($.isArray(fieldmodel)){
						for(var j = 0 ; j < fieldmodel.length; j++)
						{
							if(fieldmodel[j][idAttribute] == evtobj.data[idAttribute]){
								fieldmodel.splice(j, 1);
								break;
							}
						}
					}else{
						//dict ItemView
						self.model.set(fieldname, null);
					}
				}else{
					if($.isArray(fieldmodel)){
						for(var j = 0 ; j < fieldmodel.length; j++)
						{
							if(_.isEqual(fieldmodel[j], evtobj.data)){
								 fieldmodel.splice(j, 1);
								 break;
							 }
						}
					}else{
						self.model.set(fieldname, null);
					}
				}
    			
    			
    			self.model.trigger("change:" + fieldname);
				
			});
    		view.on('itemChanged', function(evtobj){

				var idAttribute = view.model.idAttribute;
				var fieldmodel = self.model.get(fieldname);

				if(!!idAttribute){
					if($.isArray(fieldmodel)){
						for(var j = 0 ; j < fieldmodel.length; j++)
						{
							if(fieldmodel[j][idAttribute] == evtobj.oldData[idAttribute]){
								fieldmodel[j] = evtobj.data;
								break;
							}
						}
					}else{
						//dict ItemView
						self.model.set(fieldname, evtobj.data);
					}
				}else{
					if($.isArray(fieldmodel)){
						for(var j = 0 ; j < fieldmodel.length; j++)
						{
							if(_.isEqual(fieldmodel[j], evtobj.oldData)){
								fieldmodel[j] = evtobj.data;
								break;
							}
						}
					}else{
						//dict ItemView
						self.model.set(fieldname, evtobj.data);
					}
				}
    			self.model.trigger("change:" + fieldname);
			});
    		view.render();
    		$element.append(view.$el);
			return view;
    	},
		tools : [
    	    {
    	    	name: "defaultgr",
    	    	type: "group",
    	    	groupClass: "toolbar-group",
    	    	buttons: [
					{
						name: "back",
						type: "button",
						buttonClass: "btn-default btn-sm",
						label: "TRANSLATE:BACK",
						command: function(){
							var self = this;
							//Backbone.history.history.back();
			                self.getApp().getRouter().navigate(self.collectionName + "/collection");
						}
					},
					{
		    	    	name: "save",
		    	    	type: "button",
		    	    	buttonClass: "btn-success btn-sm",
		    	    	label: "TRANSLATE:SAVE",
		    	    	command: function(){
		    	    		var self = this;
		                    self.model.save(null,{
		                        success: function (model, respose, options) {
		                            self.getApp().notify("Save successfully");
		                            self.getApp().getRouter().navigate(self.collectionName + "/collection");
		                        },
		                        error: function (model, xhr, options) {
		                            //self.alertMessage("Something went wrong while processing the model", false);
		                            self.getApp().notify('Save error');
		                        }
		                    });
		    	    	}
		    	    },
					{
		    	    	name: "delete",
		    	    	type: "button",
		    	    	buttonClass: "btn-danger btn-sm",
		    	    	label: "TRANSLATE:DELETE",
		    	    	visible: function(){
		    	    		return this.getApp().getRouter().getParam("id") !== null;
		    	    	},
		    	    	command: function(){
		    	    		var self = this;
		                    self.model.destroy({
		                        success: function(model, response) {
		                            self.getApp().getRouter().navigate(self.collectionName + "/collection");
		                        },
		                        error: function (model, xhr, options) {
		                            //self.alertMessage("Something went wrong while processing the model", false);
		                            self.getApp().notify('Delete error');
		                        }
		                    });
		    	    	}
		    	    },
    	    	]
    	    },
    	],
    	
	});
	
	Gonrin.ItemView = Gonrin.ModelView.extend({
		bindEvents : function(){
			//trigger chante
			var self = this;
			this.model.on('change', function()
			{
				self.trigger('itemChanged', {
					itemId: self.model.get(self.model.idAttribute),
					data: self.model.toJSON(),
					oldData: self.model.previousAttributes()
				});
			});
			return this;
		},
		remove: function(destroyModel){
    		var self = this;
    		
    		if(destroyModel === true){
    			self.trigger('itemDeleted', {
    				itemId: self.model.get(self.model.idAttribute),
    				data: self.model.toJSON()
    			});
    			self.model.destroy();
    		}
    		
			// COMPLETELY UNBIND THE VIEW
    		
			self.undelegateEvents();
			self.$el.removeData().unbind();
		    // Remove view from DOM
			self.$el.remove();
			_super(self, 'remove', arguments);
		    Backbone.View.prototype.remove.call(self);
    	},
    	removeBind: function(){
    		var self = this;
    		self.remove(true);
    	}
    });
	
	
	//Gonrin.User:
	var User = Gonrin.User = function(attributes){
		var self = this;
		this.cid = _.uniqueId('user');
		_.extend(this, attributes||{});
		//this._data = {};
		this.roles = this.roles || [];
		this.permision = this.permision || {};
		
	}
	User.extend = extend;
	_.extend(Gonrin.User.prototype, Backbone.Events, {
		initialize: blankMethod,
		hasRole: function(role){
			if((this.roles != null) && (this.roles.length > 0)){
				for(var i = 0; i < this.roles.length; i ++){
					if (typeof role === "string") {
						if (role === this.roles[i].role_name){
							return true;
						}
					}
					if ( typeof role === "object" ) {
						if (_.isEqual(role, this.roles[i])){
							return true;
						}
						
					}
				}
			}
			return false;
		},
		can: function(permission, subject){
			if((this.permission !== null) && this.permission.hasOwnProperty(subject)){
				return this.permission[subject][permission] || false;
			}
			return false;
		},
		cannot : function(permission, subject){
			return !this.can(permission, subject)
		}
		
	});
	
	// Gonrin.Application
	// ----------
	var appMap;
	var appProps = ['serviceURL', 'router', 'lang', 'layout', 'block', 'postLogin', 'initialize'];
	var Application = Gonrin.Application = function(attributes){
		var self = this;
		this.cid = _.uniqueId('app');
		//_.extend(this, _.pick(attributes||{}, appProps));
		_.extend(this, attributes||{});
		this.router = this.router || new Router();
		this.session = {token:null, expired:null};
		this.permission = null;
		this.currentUser = null;
		this.serviceURL = this.serviceURL || "";
		this._data = {};
		this.registerApp();
		this.initialize.apply(this, arguments);
	};
	// Set up inheritance for the app
	Application.extend = extend;
	
	_.extend(Gonrin.Application.prototype, Backbone.Events, {
		initialize: blankMethod,
		//session
		registerApp: function(){
			var self = this;
			window._gonrinApp = this;
			window.gonrinApp = function () {
			    return window._gonrinApp;
			};
		},
		data: function(key, value){
			var self = this;
			
			//return all data
			if ( key === undefined ) {
				return this._data;
			}
			if ( (typeof key === "string") && (value === undefined )) {
				return self._data.hasOwnProperty(key) ? self._data[key] : null;
			}
			
			// Sets multiple values
			if ( typeof key === "object" ) {
				$.each(key, function(k,val){
					self._data[k] = val;
				});
			}
			
			if ( (typeof key === "string") && (value !== undefined )) {
				self._data[key] = value;
			}
		},
		clearData: function(){
			this._data = {};
		},
		translate: function(str){
			if(!!str){
				if(str.startsWith('TRANSLATE:')){
					str = str.slice(10);
				}
				return this.lang[str] || str;
			}
			return "";
		},
		postLogin: function(){ return this },
		
		getRouter: function(){
			return this.router;
		},
		notify:function(args){
			if($.notify){
				$.notify.apply(null, arguments);
			}
		},
		dialog:function(){
			if(gonrin.dialog){
				gonrin.dialog.dialog.apply(this,arguments);
			}
		},
		alert:function(){
			if(gonrin.dialog){
				gonrin.dialog.alert.apply(this,arguments);
			}
		},
		confirm:function(){
			if(gonrin.dialog){
				gonrin.dialog.confirm.apply(this,arguments);
			}
		},
		loading:function(show){
			if(show === false){
				//hide loading bar
				
			}else{
				
			}
		},
	});
	
	function parseQueryString(querystring) {
	    var obj = {};
	    function sliceUp(x) { x.replace('?', '').split('&').forEach(splitUp); }
	    function splitUp(x) { var str = x.split('='); obj[str[0]] = decodeURIComponent(str[1]); }
	    try { (!querystring ? sliceUp(location.search) : sliceUp(querystring)); } catch(e) {}
	   return obj;
	}
	
	//router
	var Router = Gonrin.Router = Backbone.Router.extend({
		currentPage: null,
		getApp: function(){
			return gonrinApp();
		},
		errorPage: function(){
			this.navigate("error");
		},
		defaultRoute:function(){
        	this.navigate("index",true);
        },
		currentRoute : function() {
		    var self = this,
		        fragment = Backbone.history.fragment,
		        routes = _.pairs(self.routes),
		        route = null, params = null,querystring = null,extractparams = null, matched;

		    matched = _.find(routes, function(handler) {
		        route = _.isRegExp(handler[0]) ? handler[0] : self._routeToRegExp(handler[0]);
		        return route.test(fragment);
		    });

		    if(matched) {
		        // NEW: Extracts the params using the internal
		        // function _extractParameters 
		    	extractparams = self._extractParameters(route, fragment);
		        route = matched[1];
		    }
		    
		    if(extractparams && extractparams.length > 1){
		    	querystring = extractparams[1];
		    };
		    
		    params = parseQueryString(querystring);
		    
		    return {
		        route : route,
		        fragment : fragment,
		        params : params
		    };
		},
		getParam: function(param){
			var current_params = this.currentRoute();
			params = current_params.params || {};
			if(!!param && (typeof param === "string")){
				return params[param] || null
			}else{
				return params;
			}
		},
		refresh: function(){
			Backbone.history.loadUrl(Backbone.history.fragment);
		}
	});

	Router.prototype.navigate = _.wrap(Backbone.Router.prototype.navigate, function(){ 
		var args = _.toArray(arguments);
		var original = args.shift();
		if((args.length > 0) && (args.length < 3)){
			if(!args[1]){
				args.push(true);
			}
			Backbone.trigger('before:hash-change', args);
			var res = original.apply(this, args);
			Backbone.trigger('hash-changed');
			return res;
		}
		return this;
	});

	
	Gonrin.DialogView = Gonrin.View.extend({
		uiControl: {},
    	$dialog: null,
    	tools : [],
    	render:function(){
    		return this;
    	},
    	close: function(){
    		var self = this;
    		if (!!self.$dialog){
    			self.$dialog.modal("hide");
    		}
    	},
    	dialog: function(options){
    		var self = this;
    		this.initToolbar(this.tools);
    		//this.applyBindings();
    		
    		//self.$dialog = gonrin.dialog.dialog({message:self.$el});
    		var opts = $.extend({}, {message:self.$el}, (options|| {}));
    		self.$dialog = gonrin.dialog.dialog(opts);
    		self.render();
    		return this;
    	}
    });
	Gonrin.CollectionDialogView = Gonrin.CollectionView.extend({
    	$dialog: null,
    	tools : [
 	    	    {
 	    	    	name: "defaultgr",
 	    	    	type: "group",
 	    	    	groupClass: "toolbar-group",
 	    	    	buttons: [
 						{
 			    	    	name: "select",
 			    	    	type: "button",
 			    	    	buttonClass: "btn-success btn-sm",
 			    	    	label: "TRANSLATE:SELECT",
 			    	    	command: function(){
 			    	    		var self = this;
 			    	    		self.trigger("onSelected");
 			    	    		self.close();
 			    	    	}
 			    	    },
 	    	    	]
 	    	    },
 	    	],
    	
    	render:function(){
    		return this;
    	},
    	
    	close: function(){
    		var self = this;
    		if (!!self.$dialog){
    			self.$dialog.modal("hide");
    		}
    	},
    	dialog: function(options){
    		var self = this;
    		this.initToolbar(this.tools);
    		//this.applyBindings();
    		this.render();
    		//self.$dialog = gonrin.dialog.dialog({message:self.$el});
    		var opts = $.extend({}, {message:self.$el}, (options|| {}));
    		self.$dialog = gonrin.dialog.dialog(opts);
    		return this;
    	}
    });
	
	Gonrin.ModelDialogView = Gonrin.ModelView.extend({
    	$dialog: null,
    	tools : [],
    	render:function(){
    		return this;
    	},
    	close: function(){
    		var self = this;
    		if (!!self.$dialog){
    			self.$dialog.modal("hide");
    		}
    	},
    	dialog: function(options){
    		var self = this;
    		this.initToolbar(this.tools);
    		//this.applyBindings();
    		self.render();
    		var opts = $.extend({}, {message:self.$el}, (options|| {}));
    		self.$dialog = gonrin.dialog.dialog(opts);
    		return this;
    	}
    });
	
	Gonrin.FilterView = Gonrin.ModelView.extend({
    	sessionKey : null,
    	getDataFromSession: function(){
    		var self = this;
    		if((self.sessionKey !== null) && (self.sessionKey.length > 0)){
    			for (var key in self.model.attributes) {
        	        if (hasOwnProperty.call(self.model.attributes, key)){
        	        	self.model.set(key,self.getApp().data(self.sessionKey + key) || null);
        	        }
        	    }
    		}
    		return this;
    	},
    	saveDataToSession: function(){
    		var self = this;
    		if((self.sessionKey !== null) && (self.sessionKey.length > 0)){
    			for (var key in self.model.attributes) {
        	        if (hasOwnProperty.call(self.model.attributes, key)){
        	        	self.getApp().data(self.sessionKey + key,self.model.get(key));
        	        }
        	    }
    		}
    		return this;
    	},
    	isEmptyFilter: function(){
    		var self = this;
    		for (var key in self.model.attributes) {
    	        if (hasOwnProperty.call(self.model.attributes, key)){
    	        	if (self.model.get(key) !== null){
    	        		return false;
    	        	}
    	        }
    	    }
    		return true;
    	},
    	triggerFilter: function(){
    		var self = this;
    		if((self.sessionKey !== null) && (self.sessionKey.length > 0)){
    			self.saveDataToSession();
    		};
			self.trigger('filterChanged', {
				data: self.model.toJSON()
			});
    	}
    });
	
	return Gonrin;
}));