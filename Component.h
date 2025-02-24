#ifndef COMPONENT_H
#define COMPONENT_H

#include <iostream>
#include <string>
#include "Object.h"

// DONT INCLUDE THESE, it messes things up
class Transform;
class GameObject;

class Component : public Object
{
public:
	GameObject* gameObject = nullptr;
	Transform* transform = nullptr;

	Component(const std::string& _name) : Object(_name) { }
	//~Component();

	// these are behaviours -> monobehaviours
	virtual void Start() {

	}

	virtual void Update() {

	}

	virtual void Destroy() {

	}
};

#endif
